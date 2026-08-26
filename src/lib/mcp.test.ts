/**
 * The MCP manager writes into files the CLIs read at their next start — and
 * a server saved with a bad name, a stdio entry with no command or a remote
 * one with a `ftp://` address does not fail here, it fails silently in the
 * CLI. So the form's rules live in one pure module and are locked down:
 * what counts as valid, how the env block is spelled, how the CLIs are
 * ordered on screen, and what changes when an entry is copied to a CLI with
 * a different dialect.
 */
import { describe, expect, it } from "vitest";

import type { AgentInfo } from "./ipc";
import {
  copyTo,
  draftOf,
  fromEnvLines,
  groupByCli,
  MCP_SUPPORTED,
  scopesFor,
  toEnvLines,
  validateServer,
  type McpDraft,
  type McpRow,
} from "./mcp";

const blank: McpDraft = {
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  url: "",
  envText: "",
  headersText: "",
  enabled: true,
};

function agent(id: string, name: string, installed: boolean): AgentInfo {
  return {
    id,
    name,
    bin: installed ? `C:\\bin\\${id}.cmd` : null,
    version: installed ? "1.0" : null,
    installed,
    resumeTemplate: null,
    continueArgs: null,
    sessionsKind: null,
    docs: null,
  };
}

function row(cli: string, name: string, extra: Partial<McpRow> = {}): McpRow {
  return {
    cli,
    scope: "user",
    name,
    transport: "stdio",
    command: "npx",
    args: ["-y", name],
    url: null,
    envKeys: [],
    headerKeys: [],
    sourceFile: `C:\\home\\.${cli}.json`,
    enabled: true,
    canToggle: false,
    ...extra,
  };
}

describe("validateServer", () => {
  it("accepts a stdio server with a slug name, a command and quoted args", () => {
    const v = validateServer({
      ...blank,
      name: "context7",
      command: "npx",
      argsText: '-y "@upstash/context7-mcp" --port 8080',
      envText: "TOKEN=abc\nDEBUG=",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.server).toEqual({
      name: "context7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp", "--port", "8080"],
      url: null,
      env: { TOKEN: "abc", DEBUG: "" },
      headers: {},
      enabled: true,
    });
  });

  it("refuses a name that is not a slug — it becomes a JSON key and a TOML table name", () => {
    for (const name of ["", "my server", "a/b", ".hidden", "ok?"]) {
      const v = validateServer({ ...blank, name, command: "x" });
      expect(v.ok, name).toBe(false);
      if (!v.ok) expect(v.errors.name).toBeTruthy();
    }
    expect(validateServer({ ...blank, name: "srv-1.b_2", command: "x" }).ok).toBe(true);
  });

  it("a stdio server needs a command; a remote one needs an http(s) address", () => {
    const noCmd = validateServer({ ...blank, name: "a" });
    expect(noCmd.ok).toBe(false);
    if (!noCmd.ok) expect(noCmd.errors.command).toBeTruthy();

    const badUrl = validateServer({ ...blank, name: "a", transport: "http", url: "ftp://x" });
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.errors.url).toBeTruthy();

    const sse = validateServer({
      ...blank,
      name: "a",
      transport: "sse",
      url: "https://h/sse",
      headersText: "Authorization=Bearer t",
    });
    expect(sse.ok).toBe(true);
    if (sse.ok) {
      expect(sse.server.url).toBe("https://h/sse");
      expect(sse.server.command).toBeNull();
      expect(sse.server.headers).toEqual({ Authorization: "Bearer t" });
    }
  });

  it("a bad env line is reported with its number, and the form is not accepted", () => {
    const v = validateServer({ ...blank, name: "a", command: "x", envText: "OK=1\n\nnot a pair" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.envText).toMatch(/linha 3/);
  });
});

describe("env lines", () => {
  it("round-trips KEY=value pairs, keeps an = inside the value and skips blank lines", () => {
    const parsed = fromEnvLines("A=1\n\nB=x=y\nC=");
    expect(parsed).toEqual({ ok: true, map: { A: "1", B: "x=y", C: "" } });
    expect(toEnvLines({ A: "1", B: "x=y", C: "" })).toBe("A=1\nB=x=y\nC=");
  });

  it("refuses a key that is not an identifier and a line with no =", () => {
    expect(fromEnvLines("1BAD=x")).toEqual({ ok: false, line: 1, error: expect.stringContaining("1BAD") });
    expect(fromEnvLines("A=1\nB")).toEqual({ ok: false, line: 2, error: expect.stringContaining("B") });
  });
});

describe("groupByCli", () => {
  it("lists the supported CLIs installed first, then the ones with servers, and the unsupported last", () => {
    const agents = [
      agent("aider", "aider", true),
      agent("codex", "Codex", true),
      agent("claude", "Claude Code", true),
      agent("gemini", "Gemini CLI", false),
      agent("opencode", "OpenCode", false),
      agent("cursor-agent", "Cursor", false),
    ];
    const rows = [row("gemini", "py"), row("claude", "c7")];
    const groups = groupByCli(rows, agents);
    expect(groups.map((g) => [g.cli, g.installed, g.supported, g.rows.length])).toEqual([
      ["claude", true, true, 1],
      ["codex", true, true, 0],
      ["gemini", false, true, 1],
      ["cursor-agent", false, true, 0],
      ["opencode", false, true, 0],
      ["aider", true, false, 0],
    ]);
    expect(groups[0].name).toBe("Claude Code");
  });

  it("a supported CLI missing from the catalog still gets a card, by its id", () => {
    const groups = groupByCli([row("opencode", "x")], []);
    expect(groups.find((g) => g.cli === "opencode")?.rows).toHaveLength(1);
    expect(groups.map((g) => g.cli).sort()).toEqual([...MCP_SUPPORTED].sort());
  });
});

describe("scopesFor", () => {
  it("only Claude Code has a local scope and Codex has only the user file", () => {
    expect(scopesFor("claude")).toEqual(["user", "local", "project"]);
    expect(scopesFor("codex")).toEqual(["user"]);
    expect(scopesFor("gemini")).toEqual(["user", "project"]);
    expect(scopesFor("cursor-agent")).toEqual(["user", "project"]);
    expect(scopesFor("opencode")).toEqual(["user", "project"]);
    expect(scopesFor("aider")).toEqual([]);
  });
});

describe("copyTo", () => {
  const sse = {
    name: "events",
    transport: "sse",
    command: null,
    args: [],
    url: "https://h/sse",
    env: {},
    headers: {},
    enabled: true,
  };

  it("keeps the entry as it is when the target speaks the same transport", () => {
    expect(copyTo(sse, "claude")).toEqual({ ok: true, server: sse, note: null });
    expect(copyTo(sse, "gemini")).toEqual({ ok: true, server: sse, note: null });
  });

  it("turns SSE into a plain URL for the CLIs that do not tell the two apart, and says so", () => {
    const r = copyTo(sse, "cursor-agent");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.server.transport).toBe("http");
      expect(r.note).toMatch(/Cursor/);
    }
    const c = copyTo(sse, "codex");
    if (c.ok) expect(c.server.transport).toBe("http");
  });

  it("refuses what cannot be expressed in the target — a WebSocket entry, an unsupported CLI", () => {
    expect(copyTo({ ...sse, transport: "ws" }, "gemini").ok).toBe(false);
    expect(copyTo(sse, "aider").ok).toBe(false);
  });
});

describe("draftOf", () => {
  it("fills the form from a row and the secrets fetched for it", () => {
    const d = draftOf(
      row("codex", "c7", { args: ["-y", "a b"], envKeys: ["TOKEN"], enabled: false }),
      { env: { TOKEN: "t" }, headers: {} },
    );
    expect(d).toEqual({
      name: "c7",
      transport: "stdio",
      command: "npx",
      argsText: '-y "a b"',
      url: "",
      envText: "TOKEN=t",
      headersText: "",
      enabled: false,
    });
  });
});
