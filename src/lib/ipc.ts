/** Compatibility facade. Runtime integration lives in desktop, data contracts in contracts. */
export { ipc, on, topics } from "../desktop/client";
export type { UnlistenFn } from "@tauri-apps/api/event";
export type * from "../contracts/types";
