/**
 * The strip that explains why a terminal is not running, with the way back.
 *
 * Shared by the tabbed pane and the canvas card — the two places a dead PTY
 * can be looked at. Suspension is deliberately worded as a state, not a
 * failure: the scrollback survives it (§4.3), and that is the whole point of
 * the feature.
 *
 * **What comes back and what does not.** "Suspenso — o histórico continua
 * aqui" is about the text on screen; the agent's *conversation* is another
 * matter, and bringing the CLI up again with the same command line starts
 * from scratch. When the CLI knows how to resume its last conversation
 * (`continueArgs` in the catalog), the strip offers that as a second button;
 * when it does not, the strip says so — instead of letting the user find out
 * by asking an agent with no memory.
 */
import { Hourglass, MessageSquareReply, Play } from "lucide-react";

import { useT } from "../../hooks/useT";
import { useAgents } from "../../stores/agentsStore";
import { useTerminals, type TerminalRuntime } from "../../stores/terminalsStore";
import type { TerminalRow } from "../../lib/ipc";

/**
 * Free RAM the backend demands before spawning an agent (`SPAWN_MIN_FREE_MB`
 * in `pty/mod.rs`). It waits up to 45 s for it — silently, with the card
 * stuck on "Iniciando" without saying why. The front end already receives the
 * free memory in the resources tick, so the same truth can be told without
 * inventing a new event: below this mark, a spawn that takes long is waiting
 * for RAM.
 */
const SPAWN_MIN_FREE_MB = 400;

export function ExitBanner({
  rt,
  term,
  onStart,
}: {
  rt: TerminalRuntime | null | undefined;
  /** The terminal row — it is where what the CLI can do comes from. */
  term?: TerminalRow;
  /** `extra` are arguments added only for this boot (resuming the conversation). */
  onStart: (extra?: string[]) => void;
}) {
  const t = useT();
  // A subscription, not a one-off read: the catalog arrives a few moments
  // after boot, and a strip already on screen needs to gain the button when
  // it lands.
  const resumeConversation = useAgents((s) => {
    // A resumed terminal (`--resume <id>`) already comes up in the right
    // conversation: the second button only exists for those with nothing on
    // the command line.
    if (term?.kind !== "agent" || term.resume?.length) return null;
    const args = s.byId[term.agentId ?? ""]?.continueArgs;
    return args?.length ? args : null;
  });

  const freeMemoryMb = useTerminals((s) => s.systemAvailableMb);
  if (
    rt?.state === "starting" &&
    term?.kind === "agent" &&
    freeMemoryMb > 0 &&
    freeMemoryMb < SPAWN_MIN_FREE_MB
  ) {
    return (
      <div className="pane-exit-banner">
        <span
          data-tip-wrap=""
          data-tip={t(
            "O Yard espera {mb} MB livres antes de subir um agente (até 45 s). Suspender um grupo ocioso libera RAM na hora.",
            { mb: SPAWN_MIN_FREE_MB },
          )}
        >
          <Hourglass size={11} aria-hidden="true" />{" "}
          {t("Esperando memória livre — {free} MB de {min} MB", {
            free: Math.round(freeMemoryMb),
            min: SPAWN_MIN_FREE_MB,
          })}
        </span>
      </div>
    );
  }

  // A spawn that failed — the binary left the PATH, the CLI was uninstalled —
  // used to draw nothing here: the reason existed only as a red line written
  // inside the terminal, and the pane looked the same as one never started.
  if (rt?.state === "error") {
    return (
      <div className="pane-exit-banner pane-exit-banner--error">
        <span data-tip-wrap="" data-tip={rt.error ?? undefined}>
          {rt.error
            ? t("Não consegui iniciar: {reason}", { reason: rt.error })
            : t("Não consegui iniciar — motivo desconhecido.")}
        </span>
        <button onClick={() => onStart()}>
          <Play size={11} /> {t("Tentar de novo")}
        </button>
      </div>
    );
  }

  if (rt?.state !== "exited") return null;
  const reason = rt.exit?.reason;
  const theAgent = term?.kind === "agent";
  return (
    <div className="pane-exit-banner">
      <span>
        {reason === "suspended"
          ? theAgent && !resumeConversation
            ? t("Suspenso — o histórico continua aqui, mas a conversa do agente não volta.")
            : t("Suspenso — o histórico continua aqui.")
          : reason === "killed"
            ? t("Encerrado por você.")
            : // "gone" is the state after a restart: the app took the process
              // tree with it and what is on screen came off the disk. Without
              // this line the card looks alive and simply eats what you type.
              reason === "gone"
              ? t("Não está rodando — isto é o histórico da sessão anterior.")
              : rt.exit?.code != null
                ? t("O processo saiu com código {code}.", { code: rt.exit.code })
                : t("O processo saiu.")}
      </span>
      {resumeConversation && (
        <button
          className="pane-exit-continue"
          data-tip-wrap=""
          data-tip={t("Sobe a CLI com {args} — a última conversa deste projeto volta com ela", {
            args: resumeConversation.join(" "),
          })}
          onClick={() => onStart(resumeConversation)}
        >
          <MessageSquareReply size={11} /> {t("Retomar a conversa")}
        </button>
      )}
      <button onClick={() => onStart()}>
        <Play size={11} /> {resumeConversation ? t("Começar do zero") : t("Retomar")}
      </button>
    </div>
  );
}
