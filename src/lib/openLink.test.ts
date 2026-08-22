/**
 * A link clicked inside the app has two possible destinations, and mixing
 * them up is expensive in both directions.
 *
 * The regression this locks down: the notebook sent a web address to
 * `open_external`, which **refuses anything that is not an existing path on
 * disk** — so every `https://…` in a note answered "esse arquivo não está
 * mais no disco". The other side matters just as much: a file path must not
 * become navigation, and nothing arriving from agent-written text may end up
 * in an `explorer.exe <path>`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  ipc: { openExternal: vi.fn(async () => undefined) },
}));

import { openWebAddress, webAddress } from "./openLink";
import { ipc } from "./ipc";
import { useUI } from "../stores/uiStore";

beforeEach(() => {
  vi.clearAllMocks();
  useUI.setState({ modal: null, modalPayload: null });
});

describe("webAddress", () => {
  it("recognizes a web address and completes the scheme", () => {
    expect(webAddress("https://tauri.app")).toBe("https://tauri.app");
    expect(webAddress("http://localhost:5173")).toBe("http://localhost:5173");
    expect(webAddress("www.example.com")).toBe("https://www.example.com");
    expect(webAddress("//example.com/a")).toBe("https://example.com/a");
  });

  it("nothing that is not web gets through", () => {
    expect(webAddress("C:\\Users\\a\\coisa.exe")).toBeNull();
    expect(webAddress("./vizinho.md")).toBeNull();
    expect(webAddress("#ancora")).toBeNull();
    expect(webAddress("javascript:alert(1)")).toBeNull();
    expect(webAddress("file:///C:/x")).toBeNull();
    expect(webAddress("   ")).toBeNull();
  });
});

describe("openWebAddress", () => {
  it("opens the address as a portal, never through explorer.exe", () => {
    expect(openWebAddress("https://tauri.app")).toBe(true);

    expect(useUI.getState().modal).toBe("new-portal");
    expect(useUI.getState().modalPayload).toEqual({ url: "https://tauri.app" });
    expect(ipc.openExternal).not.toHaveBeenCalled();
  });

  it("an address that is not web opens nothing", () => {
    expect(openWebAddress("C:\\Users\\a\\coisa.exe")).toBe(false);
    expect(useUI.getState().modal).toBeNull();
    expect(ipc.openExternal).not.toHaveBeenCalled();
  });
});
