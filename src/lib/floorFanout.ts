/**
 * Fan-out: one prompt, N isolated floors, one agent each.
 *
 * Each floor is a real worktree so the agents cannot overwrite each other.
 * The process is spawned here (the group is not on screen, so no XTermView
 * will attach-and-spawn). The prompt is typed in once the CLI goes quiet,
 * the same way a role briefing is.
 */
import { nanoid } from "nanoid";

import { createFloor } from "./floorCreate";
import { uniqueFloorName, type FloorTask } from "./floors";
import { closeGroup, startTerminalProcess } from "./lifecycle";
import { placeCard } from "./canvasWrite";
import { deliverBriefing } from "./roleBrief";
import type { AgentInfo } from "./ipc";
import { useProjects } from "../stores/projectsStore";

export interface FanoutAgent {
  id: string;
  name: string;
  program: string;
  args?: string[];
}

export function agentAsFanout(a: AgentInfo): FanoutAgent | null {
  if (!a.installed || !a.bin) return null;
  return { id: a.id, name: a.name, program: a.bin };
}

export interface FanoutInput {
  projectId: string;
  name: string;
  prompt: string;
  agents: FanoutAgent[];
  copyGround?: boolean;
}

export interface FanoutFloor {
  groupId: string;
  terminalId: string;
  agentId: string;
  name: string;
}

export interface FanoutResult {
  task: FloorTask;
  floors: FanoutFloor[];
  /**
   * What went wrong, one line per agent.
   *
   * Before, a failure mid-fleet took the whole call down — the floors already
   * created were left behind without a mention — and a process that failed to
   * come up was swallowed in silence, with the final notice counting every
   * floor as "up". Whoever launches five agents needs to know that three came
   * up.
   */
  failures: string[];
  /** Floors created whose process did not come up — the card's ▶ starts them. */
  notStarted: FanoutFloor[];
}

export async function fanOutTask(input: FanoutInput): Promise<FanoutResult> {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) throw new Error("dê um nome à tarefa");
  if (!prompt) throw new Error("escreva o pedido que os agentes vão receber");
  if (input.agents.length === 0) throw new Error("escolha pelo menos um agente");

  const task: FloorTask = {
    id: nanoid(10),
    prompt,
    createdAt: Date.now(),
  };

  const floors: FanoutFloor[] = [];
  const failures: string[] = [];
  const notStarted: FanoutFloor[] = [];
  for (const agent of input.agents) {
    const s = useProjects.getState();
    const floorName = uniqueFloorName(
      s.groupsOf(input.projectId),
      `${name} · ${agent.name}`,
    );
    let created;
    try {
      created = await createFloor({
        projectId: input.projectId,
        name: floorName,
        copyGround: !!input.copyGround,
        activate: false,
        task,
        agentId: agent.id,
      });
    } catch (e) {
      // This agent's floor was not born; the others carry on. Aborting here
      // left behind the ones already created, without saying anything.
      failures.push(`${agent.name}: não consegui criar o andar (${e})`);
      continue;
    }
    if (created.provision.kind !== "isolated") {
      await closeGroup(created.groupId);
      // Without git there is no isolation for anyone: it is the one case where
      // carrying on would be worse, because the agents would trample each
      // other in the same folder.
      throw new Error(
        "esta pasta não é um repositório git — a tarefa precisa de um andar isolado por agente",
      );
    }
    const cwd = created.provision.path;

    const terminalId = s.addTerminal({
      groupId: created.groupId,
      title: agent.name,
      kind: "agent",
      agentId: agent.id,
      program: agent.program,
      args: agent.args ?? [],
      cwd,
    });
    placeCard(created.groupId, terminalId);
    try {
      await startTerminalProcess(terminalId, {
        program: agent.program,
        args: agent.args ?? [],
        cwd,
        kind: "agent",
        title: agent.name,
      });
      const briefing =
        `[Yard · Tarefa "${name}"]\n\n${prompt}\n\n` +
        "Trabalhe só neste worktree. Quando terminar, faça commit das mudanças.";
      void deliverBriefing(terminalId, briefing);
    } catch (e) {
      // The card stays. The user (or ▶) starts it; a spawn that failed
      // mid-fleet must not abort the agents that have not been created yet —
      // but now it is counted, instead of vanishing in silence.
      failures.push(`${agent.name}: o andar existe, mas o processo não subiu (${e})`);
      notStarted.push({
        groupId: created.groupId,
        terminalId,
        agentId: agent.id,
        name: floorName,
      });
    }
    floors.push({
      groupId: created.groupId,
      terminalId,
      agentId: agent.id,
      name: floorName,
    });
  }

  return { task, floors, failures, notStarted };
}
