/**
 * UI log bridge into `yard.log`.
 *
 * A packaged app has no console to open. Without this, a React boot error
 * becomes an unexplained white window — on your machine and, worse, on the
 * machine of whoever reported the bug.
 */
import { invoke } from "@tauri-apps/api/core";

type Level = "info" | "warn" | "error" | "debug";

function send(level: Level, message: string) {
  void invoke("ui_log", { level, message }).catch(() => {
    /* backend unavailable: the dev console still has the message */
  });
}

export const uiLog = {
  info: (msg: string) => send("info", msg),
  warn: (msg: string) => send("warn", msg),
  error: (msg: string) => send("error", msg),
  debug: (msg: string) => send("debug", msg),
};

/** Captures everything that would escape to the console and vanish. */
export function installErrorBridge() {
  window.addEventListener("error", (e) => {
    send("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    send("error", `promessa rejeitada: ${describe(e.reason)}`);
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    original(...args);
    send("error", args.map(describe).join(" "));
  };
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
