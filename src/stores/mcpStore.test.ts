/**
 * The store is the only path between the screen and the CLI's files. What
 * these rules lock: a write is followed by a fresh read of the files (the
 * screen never shows a server the file does not hold), a failure keeps the
 * last good listing and says why, and an answer for a project the user has
 * already left never overwrites the current one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpListing, McpRow, McpSecrets, McpServer } from "../lib/ipc";

const { mcpList, mcpSave, mcpDelete, mcpEnvValues, mcpProbe } = vi.hoisted(() => ({
  mcpProbe: vi.fn(async () => ({ serverName: "fixture", serverVersion: "1", protocolVersion: "2025-06-18", tools: 2 })),
  mcpList: vi.fn(async (_root: string | null): Promise<McpListing> => ({ rows: [], errors: [] })),
  mcpSave: vi.fn(async (_c: string, _s: string, _r: string | null, _server: McpServer) => {}),
  mcpDelete: vi.fn(async (_c: string, _s: string, _r: string | null, _n: string) => {}),
  mcpEnvValues: vi.fn(async (_c: string, _s: string, _r: string | null, _n: string): Promise<McpSecrets> => ({
    env: { TOKEN: "t" },
    headers: {},
  })),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { mcpList, mcpSave, mcpDelete, mcpEnvValues, mcpProbe },
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
  mcpProbe.mockClear();
  mcpEnvValues.mockClear();
  mcpList.mockImplementation(async () => ({ rows: [], errors: [] }));
  mcpSave.mockImplementation(async () => {});
  mcpDelete.mockImplementation(async () => {});
  useMcp.setState({ accounts: {}, health: {}, rows: [], fileErrors: [], loading: false, error: null, root: null });
});

describe("mcpStore", () => {
  it("writes to the account whose configuration was opened even after the default changes", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "c7")], errors: [], accounts: { claude: "work" } });
    await useMcp.getState().load(null);
    mcpList.mockResolvedValueOnce({ rows: [], errors: [], accounts: { claude: "personal" } });
    expect(await useMcp.getState().save("claude", "user", server)).toBe(true);
    expect(mcpSave).toHaveBeenCalledWith("claude", "user", null, server, "work");
  });
  it("starts only one connection probe while that server is already pending", async () => {
    let finish!: (result: { serverName: string; serverVersion: string; protocolVersion: string; tools: number }) => void;
    mcpProbe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = useMcp.getState().probe(row("claude", "configured"));
    await useMcp.getState().probe(row("claude", "configured"));
    expect(mcpProbe).toHaveBeenCalledTimes(1);
    finish({ serverName: "fixture", serverVersion: "1", protocolVersion: "2025-06-18", tools: 2 });
    await first;
  });
  it("discards a connection result after switching projects or refreshing configuration", async () => {
    await useMcp.getState().load("A");
    let finish!: (result: { serverName: string; serverVersion: string; protocolVersion: string; tools: number }) => void;
    mcpProbe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const probing = useMcp.getState().probe(row("claude", "configured"));
    await useMcp.getState().load("B");
    finish({ serverName: "old", serverVersion: "1", protocolVersion: "2025-06-18", tools: 2 });
    await probing;
    expect(useMcp.getState().health).toEqual({});
  });
  it("reports a completed connection probe for its configured server", async () => {
    await useMcp.getState().load("A");
    await useMcp.getState().probe(row("claude", "configured"));
    expect(useMcp.getState().health["claude:user:configured"]).toEqual({
      state: "healthy", result: { serverName: "fixture", serverVersion: "1", protocolVersion: "2025-06-18", tools: 2 },
    });
  });
  it("keeps the newly selected project when an older project's save finishes", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-a")], errors: [] });
    await useMcp.getState().load("A");
    let finish!: () => void;
    mcpSave.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const saving = useMcp.getState().save("claude", "project", server);
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-b")], errors: [] });
    await useMcp.getState().load("B");
    finish();
    expect(await saving).toBe(true);
    expect(useMcp.getState().root).toBe("B");
    expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["of-b"]);
  });

  it("keeps the newly selected project when an older project's deletion finishes", async () => {
    await useMcp.getState().load("A");
    let finish!: () => void;
    mcpDelete.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const removing = useMcp.getState().remove("claude", "project", "obsolete");
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-b")], errors: [] });
    await useMcp.getState().load("B");
    finish();
    expect(await removing).toBe(true);
    expect(useMcp.getState().root).toBe("B");
    expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["of-b"]);
  });

  it("keeps an older project's failed write from replacing the current project's error state", async () => {
    for (const operation of ["save", "remove"] as const) {
      await useMcp.getState().load("A");
      let fail!: (reason: Error) => void;
      const boundary = operation === "save" ? mcpSave : mcpDelete;
      boundary.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
      const writing = operation === "save" ? useMcp.getState().save("claude", "project", server)
        : useMcp.getState().remove("claude", "project", "obsolete");
      mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-b")], errors: [] });
      await useMcp.getState().load("B");
      fail(new Error("Old project write failed"));
      expect(await writing).toBe(false);
      expect(useMcp.getState().root).toBe("B");
      expect(useMcp.getState().error).toBeNull();
      expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["of-b"]);
    }
  });

  it("hides the previous project's servers while the newly selected project is loading", async () => {
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-a")], errors: ["Old project configuration failed"] });
    await useMcp.getState().load("A");
    let finish!: (listing: McpListing) => void;
    mcpList.mockImplementationOnce(() => new Promise<McpListing>((resolve) => { finish = resolve; }));
    const loading = useMcp.getState().load("B");
    expect(useMcp.getState().rows).toEqual([]);
    expect(useMcp.getState().fileErrors).toEqual([]);
    finish({ rows: [row("claude", "of-b")], errors: [] });
    await loading;
    expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["of-b"]);
  });

  it("refreshes shared user configuration in the current project after an older project's write completes", async () => {
    for (const operation of ["save", "remove"] as const) {
      await useMcp.getState().load("A");
      let finish!: () => void;
      const boundary = operation === "save" ? mcpSave : mcpDelete;
      boundary.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      const writing = operation === "save" ? useMcp.getState().save("claude", "user", server)
        : useMcp.getState().remove("claude", "user", "obsolete");
      mcpList.mockResolvedValueOnce({ rows: [row("claude", "before-global-write")], errors: [] });
      await useMcp.getState().load("B");
      mcpList.mockResolvedValueOnce({ rows: [row("claude", "after-global-write")], errors: [] });
      finish();
      expect(await writing).toBe(true);
      expect(useMcp.getState().root).toBe("B");
      expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["after-global-write"]);
    }
  });

  it("shows a failed shared user write in the current project without changing that project", async () => {
    await useMcp.getState().load("A");
    let fail!: (reason: Error) => void;
    mcpSave.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const saving = useMcp.getState().save("claude", "user", server);
    mcpList.mockResolvedValueOnce({ rows: [row("claude", "of-b")], errors: [] });
    await useMcp.getState().load("B");
    fail(new Error("Shared user configuration could not be saved"));
    expect(await saving).toBe(false);
    expect(useMcp.getState().root).toBe("B");
    expect(useMcp.getState().error).toBe("Shared user configuration could not be saved");
    expect(useMcp.getState().rows.map((row) => row.name)).toEqual(["of-b"]);
  });

  it("refuses a project write from a form belonging to a project that is no longer selected", async () => {
    await useMcp.getState().load("B");
    expect(await useMcp.getState().save("claude", "project", server, "A")).toBe(false);
    expect(await useMcp.getState().remove("claude", "local", "obsolete", "A")).toBe(false);
    expect(mcpSave).not.toHaveBeenCalled();
    expect(mcpDelete).not.toHaveBeenCalled();
    expect(useMcp.getState().root).toBe("B");
    expect(useMcp.getState().error).toBe("O projeto mudou. Confira os servidores MCP antes de continuar.");
  });

  it("reads an explicitly captured server context instead of silently using a newly selected project", async () => {
    await useMcp.getState().load("B");
    mcpEnvValues.mockImplementationOnce(async (_cli, _scope, root) => ({ env: { OWNER_ROOT: root ?? "user" }, headers: {} }));
    const secrets = await useMcp.getState().secrets("claude", "project", "original-server", "A");
    expect(secrets.env).toEqual({ OWNER_ROOT: "A" });
    expect(useMcp.getState().root).toBe("B");
    expect(JSON.stringify(useMcp.getState())).not.toContain("OWNER_ROOT");
  });

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
