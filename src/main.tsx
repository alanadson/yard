import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installErrorBridge, uiLog } from "./lib/log";

// Before any render: if boot breaks, the error needs to reach the log.
installErrorBridge();
uiLog.info("UI iniciando");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // StrictMode mounts every effect twice in dev. That is intentional here:
  // if attach-before-spawn (§4.3) is wrong, the bug shows up on day 1
  // instead of as a "duplicate agent" in production.
  <React.StrictMode>
    {/* Last resort. The boundaries inside (pane, grid) catch almost
        everything first; this one exists for what breaks in the shell — and so
        a black window is never again how the app reports a defect. */}
    <ErrorBoundary where="o Yard">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
