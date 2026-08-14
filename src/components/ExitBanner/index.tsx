/**
 * The strip that explains why a terminal is not running, with the way back.
 *
 * Shared by the tabbed pane and the canvas card — the two places a dead PTY
 * can be looked at. Suspension is deliberately worded as a state, not a
 * failure: the scrollback survives it (§4.3), and that is the whole point of
 * the feature.
 */
import { Play } from "lucide-react";

import type { TerminalRuntime } from "../../stores/terminalsStore";

export function ExitBanner({
  rt,
  onStart,
}: {
  rt: TerminalRuntime | null | undefined;
  onStart: () => void;
}) {
  if (rt?.state !== "exited") return null;
  const reason = rt.exit?.reason;
  return (
    <div className="pane-exit-banner">
      <span>
        {reason === "suspended"
          ? "Suspenso — o histórico continua aqui."
          : reason === "killed"
            ? "Encerrado por você."
            : `O processo saiu${
                rt.exit?.code != null ? ` com código ${rt.exit.code}` : ""
              }.`}
      </span>
      <button onClick={onStart}>
        <Play size={11} /> Retomar
      </button>
    </div>
  );
}
