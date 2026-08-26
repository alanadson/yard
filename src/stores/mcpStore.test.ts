/**
 * The store is the only path between the screen and the CLI's files. What
 * these rules lock: a write is followed by a fresh read of the files (the
 * screen never shows a server the file does not hold), a failure keeps the
 * last good listing and says why, and an answer for a project the user has
 * already left never overwrites the current one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpListing, McpRow, McpServer } from "../lib/ipc";

const { mcpList, mcpSave, mcpDelete, mcpEnvValues } = vi.hoisted(() => ({
  mcpList: vi.fn(async (_root: string | null): Promise<McpListing> => ({ rows: [], errors: [] })),
  mcpSave: vi.fn(async (_c: string, _s: string, _r: string | null, _server: McpServer) => {}),
  mcpDelete: vi.fn(async (_c: string, _s: string, _r: string | null, _n: string) => {}),
  mcpEnvValues: vi.fn(async (_c: string, _s: string, _r: string | null, _n: string) => ({
    env: { TOKEN: "t" },
    headers: {},
  })),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { mcpList, mcpSave, mcpDelete, mcpEnvValues },
}));

import { useMcp } from "./mcpStore";

function row(cli: string, name: string): McpRow {
  return {
    cli,
    scope: "user",
    name,
    transport: "stdio",
    command: "npx",
    args: [],
    url: null,
    envKeys: [],
    headerKeys: [],
    sourceFile: "x",
    enabled: true,
    canToggle: false,
  };
}

const server: McpServer = {
  name: "c7",
  transport: "stdio",
  command: "npx",
  args: ["-y", "c7"],
  url: null,
  env: {},
  headers: {},
  enabled: true,
};

beforeEach(() => {
  mcpList.mockReset();
  mcpSave.mockReset();
  mcpDelete.mockReset();
  mcpEnvValues.mockClear();
  mcpList.mockImplementation(async () => ({ rows: [], errors: [] }));
  mcpSave.mockImplementation(async () => {});
  mcpDelete.mockImplementation(async () => {});
  useMcp.setState({ rows: [], fileErrors: [], loading: false, error: null, root: null });
});

describe("mcpStore", () => {
  it("loads the listing for a root, including the files that could not be read", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "a")], errors: ["C:\\h\\.cursor\\mcp.json: JSON inválido"] });
    await useMcp.getState().load("C:\\proj");
    const s = useMcp.getState();
    expect(mcpList).toHaveBeenCalledWith("C:\\proj");
    expect(s.rows.map((r) => r.name)).toEqual(["a"]);
    expect(s.fileErrors).toHaveLength(1);
    expect(s.root).toBe("C:\\proj");
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("a failed read keeps the last good listing and remembers why", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "a")], errors: [] });
    await useMcp.getState().load(null);
    mcpList.mockRejectedValueOnce(new Error("não achei a pasta do usuário"));
    await useMcp.getState().load(null);
    const s = useMcp.getState();
    expect(s.rows.map((r) => r.name)).toEqual(["a"]);
    expect(s.error).toMatch(/pasta do usuário/);
    expect(s.loading).toBe(false);
  });

  it("an answer for a project the user already left never overwrites the current one", async () => {
    let releaseA: (v: McpListing) => void = () => {};
    mcpList.mockImplementationOnce(() => new Promise<McpListing>((r) => (releaseA = r)));
    const a = useMcp.getState().load("A");
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-b")], errors: [] });
    await useMcp.getState().load("B");
    releaseA({ rows: [row("claude", "of-a")], errors: [] });
    await a;
    expect(useMcp.getState().rows.map((r) => r.name)).toEqual(["of-b"]);
    expect(useMcp.getState().root).toBe("B");
  });

  it("saving writes through the backend and reads the files again, so the screen shows what the file holds", async () => {
    await useMcp.getState().load("C:\\proj");
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "c7")], errors: [] });
    const ok = await useMcp.getState().save("claude", "user", server);
    expect(ok).toBe(true);
    expect(mcpSave).toHaveBeenCalledWith("claude", "user", "C:\\proj", server);
    expect(useMcp.getState().rows.map((r) => r.name)).toEqual(["c7"]);
  });

  it("a failed write returns false with the reason and leaves the listing alone", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "a")], errors: [] });
    await useMcp.getState().load(null);
    mcpSave.mockRejectedValueOnce(new Error("C:\\h\\.claude.json: JSON inválido"));
    const ok = await useMcp.getState().save("claude", "user", server);
    expect(ok).toBe(false);
    expect(useMcp.getState().error).toMatch(/\.claude\.json/);
    expect(useMcp.getState().rows.map((r) => r.name)).toEqual(["a"]);
    expect(mcpList).toHaveBeenCalledTimes(1);
  });

  it("removing goes through the backend and reloads", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("codex", "a"), row("codex", "b")], errors: [] });
    await useMcp.getState().load(null);
    mcpList.mockResolvedValueOnce({ rows: [row("codex", "b")], errors: [] });
    const ok = await useMcp.getState().remove("codex", "user", "a");
    expect(ok).toBe(true);
    expect(mcpDelete).toHaveBeenCalledWith("codex", "user", null, "a");
    expect(useMcp.getState().rows.map((r) => r.name)).toEqual(["b"]);
  });

  it("secrets are fetched on demand for one server and never kept in the store", async () => {
    const s = await useMcp.getState().secrets("codex", "user", "a");
    expect(s).toEqual({ env: { TOKEN: "t" }, headers: {} });
    expect(mcpEnvValues).toHaveBeenCalledWith("codex", "user", null, "a");
    expect(JSON.stringify(useMcp.getState())).not.toContain("TOKEN");
  });
});
