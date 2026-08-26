/**
 * The safety net under every surface.
 *
 * Without an error boundary, a single exception during render unmounts the
 * **entire** tree — React has no other path. That is what happened when a
 * `TerminalPane` selector read a `const` that did not exist yet: the window
 * went black, and since the open tab is saved in the workspace, every boot
 * after that repeated the crash. A one-line defect became an app that would
 * not open.
 *
 * The point of this boundary is not to make the error pretty: it is to
 * **contain** the damage. With one pane isolated, the other five stay up, the
 * title bar and Search keep responding, and there is still a way to close the
 * tab that broke — which is exactly what was missing that night.
 *
 * The error still goes to `yard.log` (via `crashLine`): the boundary shows
 * what happened, never hides it.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

import { crashLine, crashOf } from "../../lib/crash";
import { t } from "../../lib/i18n";
import { uiLog } from "../../lib/log";

interface Props {
  /** In the user's voice: "este painel", "o quadro", "o Yard". */
  where: string;
  /** When the app can go on without this part, the rest of it stays alive. */
  children: ReactNode;
}

interface State {
  error: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const crash = crashOf(error, this.props.where);
    uiLog.error(crashLine(crash));
    // React's stack names the component; the error's stack names the line. In
    // a minified bundle only the two together pin down the spot — when React
    // hands it over: outside dev it usually comes empty, and a bare
    // "componentes:" line in the log only gets in the reader's way.
    if (info.componentStack?.trim()) {
      uiLog.error(`componentes:${info.componentStack}`);
    }
  }

  render() {
    if (this.state.error === null) return this.props.children;
    const crash = crashOf(this.state.error, this.props.where);
    return (
      <div className="crash" role="alert">
        <div className="crash-inner">
          <AlertTriangle size={20} aria-hidden="true" />
          <h2>{t("Alguma coisa quebrou em {where}", { where: crash.where })}</h2>
          {/* The raw message, on purpose: it is what the user pastes when
              they come to report the defect. */}
          <code className="crash-msg">{crash.message}</code>
          <p>
            {t("O resto do Yard continua funcionando — os outros painéis, a barra e a Busca. O erro completo está no")}{" "}
            <code>yard.log</code>.
          </p>
          <div className="crash-actions">
            <button
              className="btn btn--sm"
              onClick={() => this.setState({ error: null })}
            >
              <RotateCcw size={12} /> {t("Tentar de novo")}
            </button>
            <button className="btn btn--sm" onClick={() => window.location.reload()}>
              <RefreshCw size={12} /> {t("Recarregar o Yard")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
