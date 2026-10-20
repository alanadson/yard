/**
 * The one seam of the bridge that crosses from one group to another:
 * `yard recruit "Nome" --floor "Frente"`.
 *
 * The pure rules of the CLI live in `bridgeCore.ts` and are tested there.
 * This file exists for a single thing the pure part cannot see: where the
 * recruit is born. A front is a project's group, and a project's group has
 * no canvas (the canvas is the boards, `lib/surface.ts`), so the recruit is a
 * **tab** of that front, and no rectangle is written for it anywhere. The
 * contract that changed: it used to be a card on the front's canvas, drawn
 * on a board the front could show; the front cannot show one any more, and a
 * card there would be a CLI nobody can see.
 *
 * It also holds the cost limits that only exist at the seam (the parts that
 * decide are pure and tested in `automationPause.ts`, `askHops.ts` and
 * `bridgeGuards.ts`): what refuses while automation is paused, what an agent
 * may create without the user, how much text and how many agents one call
 * may cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMock = vi.hoisted(() => ({
  spawnPty: vi.fn(async () => ({ id: "x", alive: true, cols: 120, rows: 38 })),
  saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 1 })),
  readPrefs: vi.fn(async () => ({}) as Record<string, string>),
  writePref: vi.fn(async () => undefined),
  detectAgents: vi.fn(async (): Promise<unknown[]> => []),
  ptyProbe: vi.fn(async (): Promise<{ alive: boolean; totalBytes: number }> => ({ alive: true, totalBytes: 0 })),
  ptyReadSince: vi.fn(async () => ({ alive: true, totalBytes: 0, data: "" })),
  writePty: vi.fn(async (_id: string, _text: string, _submit?: boolean) => undefined),
  appPaths: vi.fn(async () => ({ appDir: "C:/Yard", dbPath: "", logsDir: "", backupsDir: "" })),
  fsWriteText: vi.fn(async () => ({ modifiedAt: 0, size: 0 })),
}));

vi.mock("./ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));
vi.mock("./roleBrief", () => ({ deliverBriefing: vi.fn() }));

import { handleBridgeRequest } from "./bridge";
import { EMPTY_CANVAS, type CanvasData } from "./canvas";
import { useAgentDefaults } from "../stores/agentDefaultsStore";
import { useAutomation } from "../stores/automationStore";
import { useProjects } from "../stores/projectsStore";
import { useTerminals, type TerminalRuntime } from "../stores/terminalsStore";
import { DEFAULT_PREFS, useUI } from "../stores/uiStore";

const PROJECT = "C:/proj";

beforeEach(() => {
  // `commitCanvasExternal` tells the mounted canvas to re-read itself. There
  // is no DOM here and the event has no listener either way.
  vi.stubGlobal("window", { dispatchEvent: () => true, addEventListener: () => {} });
  for (const mock of Object.values(ipcMock)) mock.mockClear();
  ipcMock.ptyProbe.mockImplementation(async () => ({ alive: true, totalBytes: 0 }));
  ipcMock.ptyReadSince.mockImplementation(async () => ({ alive: true, totalBytes: 0, data: "" }));
  ipcMock.detectAgents.mockImplementation(async () => []);
  useAutomation.setState({ paused: null, suppressed: null });
  useUI.setState({ prefs: { ...DEFAULT_PREFS }, toasts: [] });
  useTerminals.setState({ byId: {} });
  useAgentDefaults.setState({ defaults: {} });
  useProjects.setState({
    rev: 1,
    loaded: true,
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
  });
});

/** A project with one Claude Code card on the ground floor, the caller of every command. */
function seedCaller() {
  const s = useProjects.getState();
  const projectId = s.addProject("proj", PROJECT)!;
  const ground = s.groupsOf(projectId)[0];
  const caller = s.addTerminal({
    groupId: ground.id,
    title: "Claude",
    kind: "agent",
    agentId: "claude",
    program: "claude.exe",
    cwd: PROJECT,
  });
  return { s, projectId, ground, caller };
}

const request = (terminal: string, argv: string[]) =>
  handleBridgeRequest({ terminal, argv } as Parameters<typeof handleBridgeRequest>[0]);

/**
 * The regression: the terminal row was saved with the launch that
 * `launchOf` resolved (the fixed line from Configurações › Agentes, the WSL
 * wrapper, the hooks file), but the process itself was spawned with the raw
 * program and args. The card the user saw restart with the right line had
 * come up the first time without it, so the recruit asked for permissions the
 * user had already switched off. `--replace` did it right; the other two
 * branches did not.
 */
describe("the launch a recruit is spawned with", () => {
  it("is the resolved one, the same the row was saved with, on the caller's own floor", async () => {
    const { caller } = seedCaller();
    useAgentDefaults.getState().setConfig("claude", { args: "--dangerously-skip-permissions" });

    const res = await request(caller, ["recruit", "Nova"]);

    expect(res.code).toBe(0);
    const born = useProjects.getState().terminals.find((t) => t.title === "Nova")!;
    expect(born.args).toContain("--dangerously-skip-permissions");
    expect(ipcMock.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ id: born.id, program: born.program, args: born.args }),
    );
  });

  it("is the resolved one, the same the row was saved with, when born on another front", async () => {
    const { s, projectId, caller } = seedCaller();
    s.addGroup(projectId, "Frente", { activate: false });
    useAgentDefaults.getState().setConfig("claude", { args: "--dangerously-skip-permissions" });

    const res = await request(caller, ["recruit", "Nova", "--floor", "Frente"]);

    expect(res.code).toBe(0);
    const born = useProjects.getState().terminals.find((t) => t.title === "Nova")!;
    expect(born.args).toContain("--dangerously-skip-permissions");
    expect(ipcMock.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ id: born.id, program: born.program, args: born.args }),
    );
  });
});

/**
 * The regression: `String.replace` with a string replacement expands `$$`,
 * `$&`, `` $` `` and `$'`, so `yard note edit "Plano" "custo" "US$$ 5"` wrote
 * "US$ 5" and an agent pasting a shell snippet with `$&` got the matched text
 * back instead of the two characters it typed.
 */
describe("yard note edit", () => {
  it("writes the new text literally, even when it contains $$ and $&", async () => {
    const { s, ground, caller } = seedCaller();
    const canvas: CanvasData = {
      ...EMPTY_CANVAS,
      items: [
        { id: "n1", type: "note", x: 0, y: 0, w: 230, h: 170, text: "Plano\ncusto: x", color: "#fff" },
        { id: "w1", type: "connection", from: caller, to: "n1", color: "#fff" },
      ],
    };
    s.updateCanvas(ground.id, () => canvas);

    const res = await request(caller, ["note", "edit", "Plano", "custo: x", "custo: $$ e $&"]);

    expect(res.code).toBe(0);
    const note = useProjects
      .getState()
      .layoutOf(ground.id)
      .canvas?.items.find((i) => i.id === "n1");
    expect(note && "text" in note ? note.text : null).toBe("Plano\ncusto: $$ e $&");
  });
});

describe("recruiting onto another front", () => {
  it("is born a tab of that front, with no rectangle on any board: a front has no canvas", async () => {
    const s = useProjects.getState();
    const projectId = s.addProject("proj", PROJECT)!;
    const ground = s.groupsOf(projectId)[0];
    const caller = s.addTerminal({
      groupId: ground.id,
      title: "Claude",
      kind: "agent",
      agentId: "claude",
      program: "claude.exe",
      cwd: PROJECT,
    });
    const front = s.addGroup(projectId, "Frente", { activate: false });

    const res = await handleBridgeRequest({
      terminal: caller,
      argv: ["recruit", "Nova", "--floor", "Frente"],
    } as Parameters<typeof handleBridgeRequest>[0]);

    expect(res.code).toBe(0);
    const after = useProjects.getState();
    const born = after.terminalsOf(front).find((t) => t.title === "Nova");
    expect(born?.surface).toBe("grid");
    expect(after.layoutOf(front).canvas?.nodes ?? {}).toEqual({});
    // The answer says where it went, and does not send the caller to a
    // canvas that is not there.
    expect(res.output).toContain("aba");
    expect(res.output).not.toContain("canvas");
  });
});

/**
 * A wire between an agent and a flow card is what lets that card's pipeline
 * run on the agent, so it is the user's to draw. An agent wiring itself (or a
 * teammate) to a flow was buying itself a paid pipeline per prompt.
 */
describe("yard connect", () => {
  it("refuses to wire an agent to a flow card", async () => {
    const { s, ground, caller } = seedCaller();
    s.updateCanvas(ground.id, () => ({
      ...EMPTY_CANVAS,
      items: [
        {
          id: "f1", type: "flow", x: 0, y: 0, w: 270, h: 160, color: "#fff",
          name: "Esteira", stages: [{ prompt: "revise" }],
        },
      ],
    }));

    const res = await request(caller, ["connect", "Claude", "Esteira"]);

    expect(res.code).toBe(1);
    expect(res.output).toContain("fluxo");
    const items = useProjects.getState().layoutOf(ground.id).canvas?.items ?? [];
    expect(items.some((i) => i.type === "connection")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cost limits at the seam
// ---------------------------------------------------------------------------

/** The caller plus agents wired to it on the canvas, by title. */
function seedTeam(...names: string[]) {
  const seeded = seedCaller();
  const ids = names.map((title) =>
    seeded.s.addTerminal({
      groupId: seeded.ground.id,
      title,
      kind: "agent",
      agentId: "codex",
      program: "codex.exe",
      cwd: PROJECT,
    }),
  );
  seeded.s.updateCanvas(seeded.ground.id, () => ({
    ...EMPTY_CANVAS,
    items: ids.map((id) => ({ id: `w-${id}`, type: "connection" as const, from: seeded.caller, to: id, color: "#fff" })),
  }));
  return { ...seeded, ids };
}

const canvasOf = (groupId: string) => useProjects.getState().layoutOf(groupId).canvas ?? EMPTY_CANVAS;
const typed = () => ipcMock.writePty.mock.calls.map((call) => call[1]);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("while automation is paused", () => {
  beforeEach(() => useAutomation.setState({ paused: { reason: "budget", at: 1 }, suppressed: null }));

  it("yard ask refuses and types nothing", async () => {
    const { caller } = seedTeam("Codex");

    const res = await request(caller, ["ask", "Codex", "revise", "--no-wait"]);

    expect(res.code).toBe(1);
    expect(res.output).toContain("pausada");
    expect(ipcMock.writePty).not.toHaveBeenCalled();
  });

  it("yard ask --batch refuses as a whole", async () => {
    const { caller } = seedTeam("Codex", "Gemini");

    const res = await request(caller, ["ask", "--batch", JSON.stringify({ Codex: "a", Gemini: "b" }), "--no-wait"]);

    expect(res.code).toBe(1);
    expect(res.output).toContain("pausada");
    expect(ipcMock.writePty).not.toHaveBeenCalled();
  });

  /** The other two ways one agent types a prompt into another. */
  it("yard handoff and yard worker send refuse and type nothing", async () => {
    const { s, projectId, caller } = seedTeam("Codex");
    const front = s.addGroup(projectId, "W", { activate: false });
    s.updateLayout(front, { floor: { kind: "isolated", branch: "w", task: { id: "t", prompt: "p", createdAt: 0 } } });
    s.addTerminal({ groupId: front, title: "Worker", kind: "agent", agentId: "codex", program: "codex.exe", cwd: PROJECT });

    const handoff = await request(caller, ["handoff", "Codex", "o resto"]);
    const send = await request(caller, ["worker", "send", "W", "continue"]);

    expect(handoff.code).toBe(1);
    expect(handoff.output).toContain("pausada");
    expect(send.code).toBe(1);
    expect(send.output).toContain("pausada");
    expect(ipcMock.writePty).not.toHaveBeenCalled();
  });

  it("the commands that raise agents refuse before creating anything", async () => {
    const { caller } = seedCaller();
    for (const argv of [
      ["recruit", "Nova"],
      ["worker", "create", "W", "--task", "faça"],
      ["floor", "fanout", "T", "--prompt", "faça", "--agents", "claude"],
    ]) {
      const res = await request(caller, argv);
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.output, argv.join(" ")).toContain("pausada");
    }
    expect(ipcMock.spawnPty).not.toHaveBeenCalled();
    expect(ipcMock.detectAgents).not.toHaveBeenCalled();
  });
});

/**
 * An agent arming automation that runs while nobody watches is the user's
 * call: what an agent creates is saved switched off, the user is told, and
 * the agent cannot switch it on by itself.
 */
describe("automation an agent creates", () => {
  const createTrigger = (caller: string) =>
    request(caller, ["trigger", "create", "--when", "finished", "--on", "Codex", "--ask", "Claude", "revise"]);

  it("a trigger is saved switched off, awaiting the user, and the user is told", async () => {
    const { ground, caller } = seedTeam("Codex");

    const res = await createTrigger(caller);

    expect(res.code).toBe(0);
    expect(res.output).toContain("aprovação");
    expect(canvasOf(ground.id).triggers?.[0]).toMatchObject({ enabled: false, awaitingApproval: true });
    expect(useUI.getState().toasts.some((toast) => toast.message.includes("aprovação"))).toBe(true);
  });

  it("the agent cannot resume a trigger that awaits the user", async () => {
    const { ground, caller } = seedTeam("Codex");
    await createTrigger(caller);
    const id = canvasOf(ground.id).triggers![0].id;

    const res = await request(caller, ["trigger", "resume", id]);

    expect(res.code).toBe(1);
    expect(canvasOf(ground.id).triggers?.[0].enabled).toBe(false);
  });

  it("a routine is saved switched off, awaiting the user, and the user is told", async () => {
    const { ground, caller } = seedTeam("Codex");

    const res = await request(caller, ["routine", "create", "Codex", "status", "--every", "30"]);

    expect(res.code).toBe(0);
    expect(res.output).toContain("aprovação");
    expect(canvasOf(ground.id).routines?.[0]).toMatchObject({ enabled: false, awaitingApproval: true });
    expect(useUI.getState().toasts.some((toast) => toast.message.includes("aprovação"))).toBe(true);
  });

  it("the agent cannot resume a routine that awaits the user", async () => {
    const { ground, caller } = seedTeam("Codex");
    await request(caller, ["routine", "create", "Codex", "status", "--every", "30"]);
    const id = canvasOf(ground.id).routines![0].id;

    const res = await request(caller, ["routine", "resume", id]);

    expect(res.code).toBe(1);
    expect(canvasOf(ground.id).routines?.[0].enabled).toBe(false);
  });
});

describe("yard ask --batch", () => {
  /** One admission for every automatic send: a batch wakes at most `automationMaxAgents` at once. */
  it("runs at most automationMaxAgents asks at a time", async () => {
    const { caller } = seedTeam("A", "B", "C");
    useUI.setState((s) => ({ prefs: { ...s.prefs, automationMaxAgents: 2 } }));
    const gates: (() => void)[] = [];
    ipcMock.ptyProbe.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve({ alive: true, totalBytes: 0 }))),
    );

    const pending = request(caller, ["ask", "--batch", JSON.stringify({ A: "x", B: "y", C: "z" }), "--no-wait"]);
    await flush();
    expect(gates).toHaveLength(2);
    while (gates.length) {
      gates.shift()!();
      await flush();
    }

    const res = await pending;
    expect(res.code).toBe(0);
    expect(ipcMock.writePty).toHaveBeenCalledTimes(3);
  });
});

describe("agents raising agents", () => {
  it("yard recruit refuses past eight live agents in the project", async () => {
    const { s, ground, caller } = seedCaller();
    for (let i = 0; i < 8; i++) {
      const id = s.addTerminal({ groupId: ground.id, title: `A${i}`, kind: "agent", agentId: "claude", program: "claude.exe", cwd: PROJECT });
      s.updateTerminal(id, { alive: true });
    }

    const res = await request(caller, ["recruit", "Nona"]);

    expect(res.code).toBe(1);
    expect(res.output).toContain("8");
    expect(ipcMock.spawnPty).not.toHaveBeenCalled();
  });

  it("a worker cannot recruit nor create workers", async () => {
    const { s, ground, caller } = seedCaller();
    s.updateLayout(ground.id, {
      floor: { kind: "isolated", branch: "w", task: { id: "t", prompt: "p", createdAt: 0 } },
    });
    for (const argv of [
      ["recruit", "Nova"],
      ["worker", "create", "W", "--task", "faça"],
      ["floor", "fanout", "T", "--prompt", "faça", "--agents", "claude"],
    ]) {
      const res = await request(caller, argv);
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.output, argv.join(" ")).toContain("worker");
    }
    expect(ipcMock.spawnPty).not.toHaveBeenCalled();
  });

  /** The regression: no `--agents` meant every CLI installed on the machine, each a paid worker. */
  it("yard floor fanout without --agents fails with its usage instead of using every installed agent", async () => {
    const { caller } = seedCaller();

    const res = await request(caller, ["floor", "fanout", "Login", "--prompt", "faça o login"]);

    expect(res.code).not.toBe(0);
    expect(res.output).toContain("--agents");
    expect(ipcMock.detectAgents).not.toHaveBeenCalled();
  });
});

describe("what yard ask hands back", () => {
  const RT: TerminalRuntime = {
    state: "running",
    pid: 1,
    exit: null,
    error: null,
    unread: false,
    finished: true,
    finishedAt: Number.MAX_SAFE_INTEGER,
    blocked: false,
    blockedAsk: null,
    permission: false,
    rssMb: 0,
    cpu: 0,
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Answers the ask with `chars` characters and returns the reply. */
  async function askWith(chars: number, extra: string[] = []) {
    // A fresh workspace per ask: the project path can only be added once.
    useProjects.setState({ projects: [], groups: [], terminals: [], activeProjectId: null, activeGroupId: null });
    const { caller, ids } = seedTeam("Codex");
    useTerminals.setState({ byId: { [ids[0]]: RT } });
    let bytes = 0;
    ipcMock.ptyProbe.mockImplementation(async () => ({ alive: true, totalBytes: (bytes += 100) }));
    ipcMock.ptyReadSince.mockImplementation(async () => ({ alive: true, totalBytes: 1, data: "x".repeat(chars) }));
    const pending = request(caller, ["ask", "Codex", "revise", ...extra]);
    await vi.advanceTimersByTimeAsync(2_500);
    return pending;
  }

  it("is at most 8000 characters by default", async () => {
    const res = await askWith(20_000);
    expect(res.code).toBe(0);
    expect(res.output.length).toBeGreaterThan(8_000);
    expect(res.output.length).toBeLessThan(8_100);
  });

  it("--max-chars asks for more, up to 30000", async () => {
    expect((await askWith(20_000, ["--max-chars", "20000"])).output.length).toBeGreaterThan(20_000);
    expect((await askWith(40_000, ["--max-chars", "99999"])).output.length).toBeLessThan(30_100);
  });
});

describe("the prompt yard ask types in", () => {
  it("opens with the hop stamp: who asked and how deep in the chain", async () => {
    const { caller } = seedTeam("Codex");

    await request(caller, ["ask", "Codex", "revise o login", "--no-wait"]);

    expect(typed()).toEqual(['[Yard · de "Claude" · salto 1]\nrevise o login']);
  });

  it("is refused the seventh time to the same agent within ten minutes", async () => {
    const { caller } = seedTeam("Codex");
    for (let i = 0; i < 6; i++) {
      expect((await request(caller, ["ask", "Codex", `pedido ${i}`, "--no-wait"])).code).toBe(0);
    }

    const res = await request(caller, ["ask", "Codex", "mais um", "--no-wait"]);

    expect(res.code).toBe(1);
    expect(res.output).toContain("10 min");
  });

  it("over 32 KB travels as a file the agent is told to read", async () => {
    const { caller } = seedTeam("Codex");
    const big = "linha do pedido\n".repeat(3_000);

    const res = await request(caller, ["ask", "Codex", big, "--no-wait"]);

    expect(res.code).toBe(0);
    const [root, rel, written] = ipcMock.fsWriteText.mock.calls[0] as unknown as [string, string, string];
    expect(root).toBe("C:/Yard");
    expect(rel).toMatch(/^attachments\/yard-ask-.+\.md$/);
    expect(written).toBe(big);
    const sent = typed()[0];
    expect(sent.startsWith('[Yard · de "Claude" · salto 1]\n')).toBe(true);
    expect(sent).toContain("yard-ask-");
    expect(sent.length).toBeLessThan(1_000);
  });
});
