/**
 * The command line each CLI is *always* born with.
 *
 * Before this, "sem pedir permissão" was a switch inside "Nova aba" — so the
 * one setting everybody wants permanently on had to be ticked again on every
 * single tab, and the CLIs opened by the canvas, by `yard recruit` or by a
 * fan-out could not be told at all. These rules are what make it a setting:
 * one fixed line per agent id, sifted on the way in (the kv is text, editable
 * from outside), and read by every place that spawns a CLI.
 */
import { describe, expect, it } from "vitest";

import {
  agentDefaultRows,
  cacheChoicesOf,
  cacheEnvOf,
  cacheNoteOf,
  DEFAULT_AGENT_CONFIG,
  type AgentCache,
  type AgentConfig,
  argsForChoice,
  defaultArgvOf,
  defaultRoleOf,
  isArgsTouched,
  isDefaultConfig,
  titleFor,
  launchFor,
  pickableAgents,
  pickAgentTab,
  parseAgentDefaults,
  serializeAgentDefaults,
  spawnArgv,
  withAgentConfig,
  wslLaunch,
  sshLaunch,
  shQuote,
  withAgentDefault,
} from "./agentDefaults";
import { skipFlagOf } from "./termArgs";
import type { AgentInfo } from "./ipc";

const CLAUDE_SKIP = skipFlagOf("agent", "claude");
const CODEX_SKIP = skipFlagOf("agent", "codex");

/** A config with everything at its default but the parts the test cares about. */
function cfg(patch: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...patch };
}

function agent(patch: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    name: patch.id,
    bin: `${patch.id}.exe`,
    version: null,
    installed: true,
    resumeTemplate: null,
    continueArgs: null,
    sessionsKind: null,
    docs: null,
    ...patch,
  };
}

describe("parseAgentDefaults", () => {
  it("gives nothing back for junk", () => {
    expect(parseAgentDefaults(undefined)).toEqual({});
    expect(parseAgentDefaults("")).toEqual({});
    expect(parseAgentDefaults("não é json")).toEqual({});
    expect(parseAgentDefaults("[1,2]")).toEqual({});
  });

  it("keeps only text lines, trimmed, and drops the empty ones", () => {
    const raw = JSON.stringify({
      claude: "  --dangerously-skip-permissions  ",
      codex: "",
      gemini: 42,
    });
    expect(parseAgentDefaults(raw)).toEqual({
      claude: cfg({ args: "--dangerously-skip-permissions" }),
    });
  });
});

describe("withAgentDefault", () => {
  it("erasing the line removes the agent instead of storing an empty one", () => {
    const one = withAgentDefault({}, "claude", "--dangerously-skip-permissions");
    expect(one).toEqual({ claude: cfg({ args: "--dangerously-skip-permissions" }) });
    expect(withAgentDefault(one, "claude", "   ")).toEqual({});
  });

  it("does not touch the other agents", () => {
    const two = withAgentDefault({ codex: cfg({ args: "--yolo" }) }, "claude", "--verbose");
    expect(two).toEqual({ codex: cfg({ args: "--yolo" }), claude: cfg({ args: "--verbose" }) });
  });
});

describe("defaultArgvOf", () => {
  it("is a command line, so a quoted value stays one argument", () => {
    const all = { claude: cfg({ args: '--append-system-prompt "seja breve"' }) };
    expect(defaultArgvOf(all, "claude")).toEqual([
      "--append-system-prompt",
      "seja breve",
    ]);
  });

  it("an agent with nothing configured adds nothing", () => {
    expect(defaultArgvOf({}, "claude")).toEqual([]);
    expect(defaultArgvOf({ claude: cfg({ args: "--x" }) }, null)).toEqual([]);
  });
});

describe("argsForChoice", () => {
  const claude = { fixed: "--dangerously-skip-permissions", skip: CLAUDE_SKIP };
  const codex = { fixed: "--dangerously-bypass-approvals-and-sandbox", skip: CODEX_SKIP };

  it("an empty field is filled with the chosen CLI's fixed line", () => {
    expect(argsForChoice("", null, claude)).toBe("--dangerously-skip-permissions");
  });

  it("a field still showing the previous CLI's line takes the new one's", () => {
    expect(argsForChoice(claude.fixed, claude, codex)).toBe(codex.fixed);
  });

  it("a shell has no fixed line: the field it inherited is cleared", () => {
    expect(argsForChoice(claude.fixed, claude, { fixed: "", skip: null })).toBe("");
  });

  it("what was typed by hand survives, with the flag re-spelled for the new CLI", () => {
    const typed = "--add-dir ../api --dangerously-skip-permissions";
    expect(argsForChoice(typed, claude, codex)).toBe(
      "--add-dir ../api --dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("a hand-typed line with no permission flag is left exactly as it is", () => {
    expect(argsForChoice("--add-dir ../api", claude, codex)).toBe("--add-dir ../api");
  });
});

describe("agentDefaultRows", () => {
  it("what can actually run comes first", () => {
    const rows = agentDefaultRows(
      [
        agent({ id: "aider", installed: false, bin: null }),
        agent({ id: "claude" }),
      ],
      {},
    );
    expect(rows.map((r) => r.id)).toEqual(["claude", "aider"]);
  });

  it("carries the CLI's own permission flag, and null when it has none", () => {
    const rows = agentDefaultRows([agent({ id: "claude" }), agent({ id: "grok" })], {});
    expect(rows[0].skip?.args).toEqual(["--dangerously-skip-permissions"]);
    expect(rows[1].skip).toBeNull();
  });

  it("an agent that is configured but undetected is still listed", () => {
    // Otherwise a line that keeps being handed to the CLI would have no row to
    // be read or erased in — detection can also simply have failed.
    const rows = agentDefaultRows([], { codex: cfg({ args: "--yolo" }) });
    expect(rows.map((r) => r.id)).toEqual(["codex"]);
    expect(rows[0].installed).toBe(false);
    expect(rows[0].config.args).toBe("--yolo");
  });

  it("does not list the same agent twice when it is detected and configured", () => {
    const rows = agentDefaultRows([agent({ id: "claude" })], {
      claude: cfg({ args: "--verbose" }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].config.args).toBe("--verbose");
  });
});

describe("spawnArgv", () => {
  const all = { claude: cfg({ args: "--dangerously-skip-permissions" }) };

  it("adds the fixed line after what the caller already decided", () => {
    expect(spawnArgv(all, "claude", ["--resume", "abc"])).toEqual([
      "--resume",
      "abc",
      "--dangerously-skip-permissions",
    ]);
  });

  it("does not repeat a flag the caller already spelled — the role wins", () => {
    // A role reaches Claude as `--append-system-prompt`, and so can the fixed
    // line: two of them would tell the CLI to be two things at once.
    const withPrompt = {
      claude: cfg({ args: '--append-system-prompt "fale pt-BR" --verbose' }),
    };
    expect(
      spawnArgv(withPrompt, "claude", ["--append-system-prompt", "revise PRs"]),
    ).toEqual(["--append-system-prompt", "revise PRs", "--verbose"]);
  });

  it("with nothing configured, the command line comes back untouched", () => {
    expect(spawnArgv({}, "codex", ["--resume"])).toEqual(["--resume"]);
    expect(spawnArgv(all, null, [])).toEqual([]);
  });
});

describe("isArgsTouched", () => {
  it("a field still showing the fixed line does not count as typed in", () => {
    // "Nova aba" asks before discarding what was written. With the field now
    // pre-filled from Settings, that question would come up on every single
    // close if the setting's own line counted as the user's writing.
    expect(isArgsTouched("--dangerously-skip-permissions", "--dangerously-skip-permissions")).toBe(false);
    expect(isArgsTouched("", "")).toBe(false);
    expect(isArgsTouched("   ", "")).toBe(false);
  });

  it("anything else is the user's, and is worth asking about", () => {
    expect(isArgsTouched("--add-dir ../api", "--dangerously-skip-permissions")).toBe(true);
    expect(isArgsTouched("--verbose", "")).toBe(true);
  });
});

/**
 * The per-agent setting stopped being a single line and became a small
 * record — where the CLI runs, how long its cache lives, whether it is
 * offered at all. What was written by the version that only knew the line has
 * to survive that, or everyone's "sem pedir permissão" would silently switch
 * itself off on upgrade.
 */
describe("parseAgentDefaults — the record shape", () => {
  it("a profile written by the previous version keeps its line", () => {
    const raw = JSON.stringify({ claude: "--dangerously-skip-permissions" });
    expect(parseAgentDefaults(raw)).toEqual({
      claude: { ...DEFAULT_AGENT_CONFIG, args: "--dangerously-skip-permissions" },
    });
  });

  it("reads the record back, filling in what is missing", () => {
    const raw = JSON.stringify({ claude: { args: "--verbose", where: "wsl", distro: "Ubuntu" } });
    expect(parseAgentDefaults(raw)).toEqual({
      claude: cfg({ args: "--verbose", where: "wsl", distro: "Ubuntu" }),
    });
  });

  it("a value the app does not know becomes the default, not a broken spawn", () => {
    // kv is text and editable from outside: `where: "linux"` would reach the
    // launcher as neither Windows nor WSL.
    const raw = JSON.stringify({
      claude: { args: "--verbose", where: "linux", cache: "3h", hidden: "sim" },
    });
    expect(parseAgentDefaults(raw).claude).toEqual(cfg({ args: "--verbose" }));
  });
});

describe("withAgentConfig", () => {
  it("changes one field and leaves the others alone", () => {
    const one = withAgentConfig({}, "claude", { args: "--verbose" });
    const two = withAgentConfig(one, "claude", { where: "wsl" });
    expect(two.claude).toEqual({ ...DEFAULT_AGENT_CONFIG, args: "--verbose", where: "wsl" });
  });

  it("a config back to its defaults leaves no row behind in the kv", () => {
    const one = withAgentConfig({}, "claude", { hidden: true });
    expect(withAgentConfig(one, "claude", { hidden: false })).toEqual({});
  });
});

describe("serializeAgentDefaults", () => {
  it("an agent with nothing but a line is still written as that line", () => {
    // The row stays readable in the kv, and a downgrade keeps working.
    const all = withAgentConfig({}, "claude", { args: "--verbose" });
    expect(serializeAgentDefaults(all)).toEqual({ claude: "--verbose" });
  });

  it("anything more becomes the record", () => {
    const all = withAgentConfig({}, "claude", { args: "--verbose", cache: "1h" });
    expect(serializeAgentDefaults(all)).toEqual({
      claude: { args: "--verbose", cache: "1h" },
    });
  });
});

/**
 * Running the agent inside WSL is a different command line, not a flag: the
 * process that is spawned is `wsl.exe`, and everything the card knew — the
 * binary, its arguments, the folder — has to survive the translation.
 */
describe("wslLaunch", () => {
  // `String.raw`, because a Windows path in a plain literal is a minefield:
  // `\n` in `\npm` is a newline and `\a` in `\api` is a bell — the fixture
  // stops being a path and the test asserts nonsense on both sides.
  const base = {
    program: String.raw`C:\Users\alan\AppData\Roaming\npm\claude.cmd`,
    args: ["--dangerously-skip-permissions"],
    cwd: String.raw`C:\Workspace\api`,
    distro: "Ubuntu",
  };

  it("runs the bare command — the Windows shim does not exist inside the distro", () => {
    expect(wslLaunch(base).args).toContain("claude");
    expect(wslLaunch(base).args.join(" ")).not.toContain(".cmd");
    expect(wslLaunch(base).program).toBe("wsl.exe");
  });

  it("hands the folder over as a Windows path, for WSL itself to translate", () => {
    // `--cd C:\…` is what WSL documents; a `/mnt/c/…` computed here would be a
    // second, worse implementation of a translation WSL already does.
    expect(wslLaunch(base).args.slice(0, 4)).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      String.raw`C:\Workspace\api`,
    ]);
  });

  it("closes wsl's own options before the agent's, so a shared flag is not eaten", () => {
    const launch = wslLaunch({ ...base, args: ["-d", "algo", "--cd", "x"] });
    const at = launch.args.indexOf("--");
    expect(launch.args.slice(at + 1)).toEqual(["claude", "-d", "algo", "--cd", "x"]);
  });

  it("no distro chosen means the one WSL defaults to", () => {
    expect(wslLaunch({ ...base, distro: "" }).args[0]).toBe("--cd");
  });
});

describe("launchFor: the hooks the CLIs report through", () => {
  const card = { program: "claude", args: [], cwd: "C:\\p" };
  const hooks = { enabled: true, claudeSettings: "C:\\data\\bin\\claude-hooks.json" };

  it("hands Claude Code the settings file on its own flag", () => {
    expect(launchFor({}, "claude", card, hooks).args).toEqual([
      "--settings",
      "C:\\data\\bin\\claude-hooks.json",
    ]);
  });

  it("hands Codex the notify program on its own flag", () => {
    const out = launchFor({}, "codex", { ...card, program: "codex" }, hooks);
    expect(out.args).toEqual(["-c", 'notify=["yard","hook","codex"]']);
  });

  it("never doubles a flag the user already spelled, and adds nothing when off", () => {
    const spelled = launchFor({}, "claude", { ...card, args: ["--settings", "mine.json"] }, hooks);
    expect(spelled.args).toEqual(["--settings", "mine.json"]);
    expect(launchFor({}, "claude", card, { ...hooks, enabled: false }).args).toEqual([]);
    expect(launchFor({}, "claude", card, { enabled: true, claudeSettings: null }).args).toEqual([]);
  });

  it("leaves a CLI with no documented hook alone", () => {
    expect(launchFor({}, "aider", { ...card, program: "aider" }, hooks).args).toEqual([]);
  });
});

describe("launchFor", () => {
  const card = {
    program: "claude.cmd",
    args: ["--verbose"],
    cwd: String.raw`C:\api`,
  };

  it("leaves a Windows agent exactly as it was", () => {
    expect(launchFor({}, "claude", card)).toEqual({
      program: "claude.cmd",
      args: ["--verbose"],
    });
  });

  it("wraps the one told to live in the distro", () => {
    const all = withAgentConfig({}, "claude", { where: "wsl", distro: "Debian" });
    expect(launchFor(all, "claude", card)).toEqual({
      program: "wsl.exe",
      args: ["-d", "Debian", "--cd", String.raw`C:\api`, "--", "claude", "--verbose"],
    });
  });
});

/**
 * The cache setting is environment, not a flag — and only the variables the
 * CLI's own documentation names. Inventing one here would be worse than
 * having no control: the process would start fine and silently ignore it,
 * and the bill would say nothing.
 */
describe("cacheEnvOf", () => {
  const envFor = (cache: AgentCache) =>
    cacheEnvOf(withAgentConfig({}, "claude", { cache }), "claude");

  it("writes the variable each choice documents", () => {
    expect(envFor("1h")).toEqual([["ENABLE_PROMPT_CACHING_1H", "1"]]);
    expect(envFor("5m")).toEqual([["FORCE_PROMPT_CACHING_5M", "1"]]);
    expect(envFor("off")).toEqual([["DISABLE_PROMPT_CACHING", "1"]]);
  });

  it("automático says nothing, so the CLI keeps deciding for itself", () => {
    expect(envFor("")).toEqual([]);
  });

  it("an agent with no verified knob gets no variable, whatever the kv says", () => {
    const all = withAgentConfig({}, "codex", { cache: "1h" });
    expect(cacheEnvOf(all, "codex")).toEqual([]);
    expect(cacheChoicesOf("codex")).toBeNull();
  });
});

describe("pickableAgents", () => {
  it("an agent turned off is not offered", () => {
    const all = withAgentConfig({}, "codex", { hidden: true });
    const list = pickableAgents([{ id: "claude" }, { id: "codex" }], all);
    expect(list.map((a) => a.id)).toEqual(["claude"]);
  });

  it("turning it off does not remove it from the settings list", () => {
    // Otherwise the switch would be one-way: no row left to turn it back on.
    const all = withAgentConfig({}, "codex", { hidden: true });
    const rows = agentDefaultRows([agent({ id: "codex" })], all);
    expect(rows.map((r) => r.id)).toEqual(["codex"]);
    expect(rows[0].config.hidden).toBe(true);
  });
});

/**
 * Not every CLI spends its cache the same way. Claude Code reads environment
 * variables; aider takes flags — and its caching is **off** until asked, so
 * "automático" means something different there. The catalog carries both
 * shapes, and an agent with no documented knob says so instead of pretending
 * the control does not exist.
 */
describe("cache — the CLIs that are not Claude Code", () => {
  it("aider's choice reaches the command line, not the environment", () => {
    const all = withAgentConfig({}, "aider", { cache: "1h" });
    expect(launchFor(all, "aider", { program: "aider", args: [], cwd: "C:/x" }).args)
      .toEqual(["--cache-prompts", "--cache-keepalive-pings", "12"]);
    expect(cacheEnvOf(all, "aider")).toEqual([]);
  });

  it("a flag the user already typed by hand is not doubled", () => {
    const all = withAgentConfig({}, "aider", { cache: "5m" });
    const args = launchFor(all, "aider", {
      program: "aider",
      args: ["--cache-prompts"],
      cwd: "C:/x",
    }).args;
    expect(args).toEqual(["--cache-prompts"]);
  });

  it("an agent with no documented knob explains itself instead of going silent", () => {
    expect(cacheChoicesOf("codex")).toBeNull();
    expect(cacheNoteOf("codex")).toMatch(/autom/i);
    expect(cacheNoteOf("grok")).not.toBe("");
    // The two that do have one have nothing to explain away.
    expect(cacheNoteOf("claude")).toBe("");
    expect(cacheNoteOf("aider")).toBe("");
  });
});

describe("pickAgentTab", () => {
  const rows = (ids: string[]) =>
    agentDefaultRows(ids.map((id) => agent({ id })), {});

  it("shows the one that was picked", () => {
    expect(pickAgentTab(rows(["claude", "codex"]), "codex")?.id).toBe("codex");
  });

  it("an id that left the list falls back instead of an empty panel", () => {
    expect(pickAgentTab(rows(["claude", "codex"]), "sumiu")?.id).toBe("claude");
    expect(pickAgentTab(rows(["claude"]), null)?.id).toBe("claude");
  });

  it("with no agent at all there is nothing to show", () => {
    expect(pickAgentTab([], "claude")).toBeNull();
  });
});

/**
 * "Nova aba" stopped having a form: one click on a mark creates the terminal.
 * What that form asked per agent — the name it opens with and the role it is
 * born into — moved here, where it is said once instead of on every tab. What
 * it asked per *invocation* (which group, which folder) did not move: those
 * have a correct default (the pane that asked, the project's own path).
 */
describe("what a new tab is born with", () => {
  it("uses the name configured for that CLI, and the CLI's own when there is none", () => {
    const all = withAgentConfig({}, "claude", { name: "Revisor" });
    expect(titleFor(all, "claude", "Claude Code")).toBe("Revisor");
    expect(titleFor(all, "codex", "Codex CLI")).toBe("Codex CLI");
    expect(titleFor({}, null, "PowerShell")).toBe("PowerShell");
  });

  it("carries the role configured for that CLI", () => {
    const pick = { role: { name: "Revisora", text: "revise PRs" }, color: "#ff0000" };
    const all = withAgentConfig({}, "claude", { role: pick });
    expect(defaultRoleOf(all, "claude")).toEqual(pick);
    expect(defaultRoleOf(all, "codex")).toBeNull();
  });

  it("a name or a role written from outside is sifted like everything else", () => {
    const raw = JSON.stringify({
      claude: { name: 42, role: { role: { name: "R", text: "t" }, color: 7 } },
      codex: { role: "papel" },
    });
    const parsed = parseAgentDefaults(raw);
    expect(parsed.claude).toEqual(
      cfg({ role: { role: { name: "R", text: "t" } } }),
    );
    expect(parsed.codex).toBeUndefined();
  });

  it("a name and a role are part of what counts as configured", () => {
    expect(isDefaultConfig(cfg({ name: "x" }))).toBe(false);
    expect(isDefaultConfig(cfg({ role: { role: { name: "R", text: "t" } } }))).toBe(false);
    expect(isDefaultConfig(cfg())).toBe(true);
  });
});

/**
 * The regression that motivated this: "Nova aba" used to compose the command
 * line out of the field it pre-filled, so the fixed line reached the process
 * through the *dialog*. When the dialog lost its form, the line lost its only
 * ride — `--dangerously-skip-permissions` was set in Settings and every Claude
 * opened in auto mode, with nothing on screen connecting the two.
 *
 * So `launchFor` is now the whole answer to "what is this card born with":
 * the fixed line, the cache, and where it runs. A caller that forgets a step
 * cannot exist, because there are no steps to forget.
 */
describe("launchFor is everything a card is born with", () => {
  it("carries the fixed line even when the caller composed nothing", () => {
    const all = withAgentConfig({}, "claude", {
      args: "--dangerously-skip-permissions",
    });
    expect(
      launchFor(all, "claude", { program: "claude.cmd", args: [], cwd: "C:/x" }).args,
    ).toEqual(["--dangerously-skip-permissions"]);
  });

  it("what the caller decided comes first, and its flags win", () => {
    const all = withAgentConfig({}, "claude", {
      args: '--append-system-prompt "fale pt-BR" --verbose',
    });
    expect(
      launchFor(all, "claude", {
        program: "claude.cmd",
        args: ["--append-system-prompt", "revise PRs"],
        cwd: "C:/x",
      }).args,
    ).toEqual(["--append-system-prompt", "revise PRs", "--verbose"]);
  });

  it("the fixed line, the cache and the distro all land in the same command", () => {
    const all = withAgentConfig({}, "aider", {
      args: "--model sonnet",
      cache: "5m",
      where: "wsl",
      distro: "Ubuntu",
    });
    expect(
      launchFor(all, "aider", { program: "aider.cmd", args: [], cwd: "C:/x" }),
    ).toEqual({
      program: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--cd",
        "C:/x",
        "--",
        "aider",
        "--model",
        "sonnet",
        "--cache-prompts",
      ],
    });
  });
});

/**
 * Running the agent on another machine is, like WSL, a different command
 * line rather than a flag: the process Yard spawns is `ssh.exe`, and the CLI,
 * its arguments and the folder travel inside one remote command that a POSIX
 * shell on the other side has to read back exactly as they were typed here.
 */
describe("shQuote", () => {
  it("wraps in single quotes, which a POSIX shell reads verbatim", () => {
    expect(shQuote("/home/alan/api")).toBe("'/home/alan/api'");
    expect(shQuote("with space")).toBe("'with space'");
  });

  it("survives a single quote inside the value", () => {
    // The only character single quotes cannot hold: close, escape, reopen.
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("sshLaunch", () => {
  const base = {
    program: String.raw`C:\Users\alan\AppData\Roaming\npm\claude.cmd`,
    args: ["--dangerously-skip-permissions"],
    cwd: String.raw`C:\Workspace\api`,
    host: "devbox",
    remotePath: "/home/alan/api",
  };

  it("spawns ssh with a forced tty — ConPTY is not a tty from ssh's point of view", () => {
    expect(sshLaunch(base).program).toBe("ssh.exe");
    expect(sshLaunch(base).args.slice(0, 2)).toEqual(["-tt", "devbox"]);
  });

  it("runs the bare command in the remote folder — the Windows shim does not exist there", () => {
    expect(sshLaunch(base).args[2]).toBe(
      "cd '/home/alan/api' && exec claude --dangerously-skip-permissions",
    );
  });

  it("quotes every argument, so a role brief with spaces stays one word over there", () => {
    const launch = sshLaunch({ ...base, args: ["--append-system-prompt", "be nice"] });
    expect(launch.args[2]).toBe(
      "cd '/home/alan/api' && exec claude --append-system-prompt 'be nice'",
    );
  });

  it("no remote folder means the login shell's home — no cd at all", () => {
    expect(sshLaunch({ ...base, remotePath: "" }).args[2]).toBe(
      "exec claude --dangerously-skip-permissions",
    );
  });
});

describe("launchFor — over SSH", () => {
  it("wraps the one told to live on another machine", () => {
    const all = withAgentConfig({}, "claude", {
      where: "ssh",
      sshHost: "devbox",
      sshPath: "/srv/api",
    });
    expect(
      launchFor(all, "claude", { program: "claude.cmd", args: ["--verbose"], cwd: "C:\\api" }),
    ).toEqual({
      program: "ssh.exe",
      args: ["-tt", "devbox", "cd '/srv/api' && exec claude --verbose"],
    });
  });
});

describe("the ssh fields in the kv", () => {
  it("reads host and remote folder back, trimmed", () => {
    const raw = JSON.stringify({
      claude: { where: "ssh", sshHost: " devbox ", sshPath: " /srv/api " },
    });
    expect(parseAgentDefaults(raw)).toEqual({
      claude: cfg({ where: "ssh", sshHost: "devbox", sshPath: "/srv/api" }),
    });
  });

  it("writes them only when set, next to where — a Windows agent says nothing about ssh", () => {
    const all = withAgentConfig({}, "claude", { where: "ssh", sshHost: "devbox" });
    expect(serializeAgentDefaults(all)).toEqual({
      claude: { where: "ssh", sshHost: "devbox" },
    });
  });

  it("a host remembered for later is still something to say, even back on Windows", () => {
    // Switching the picker back to Windows must not erase the host the user
    // typed: the row stays in the kv so the next switch to SSH finds it.
    const all = withAgentConfig({}, "claude", { sshHost: "devbox" });
    expect(isDefaultConfig(all.claude)).toBe(false);
    expect(serializeAgentDefaults(all)).toEqual({ claude: { sshHost: "devbox" } });
  });
});

describe("sshLaunch carrying the bridge", () => {
  /**
   * Why this matters: "roda em SSH" shipped with the `yard` CLI not crossing
   * the connection, so a remote agent could not answer another one, read a
   * note or say it had finished. The tunnel and the shim are what close it,
   * and both have to be there, a shim with no tunnel is a CLI that hangs.
   */
  const base = {
    program: "claude.cmd",
    args: ["--resume", "abc"],
    cwd: "D:\repo",
    host: "servidor",
    remotePath: "/home/alguem/repo",
  };

  it("without a bridge, launches exactly as it always did", () => {
    const out = sshLaunch(base);
    expect(out.program).toBe("ssh.exe");
    expect(out.args[0]).toBe("-tt");
    expect(out.args[1]).toBe("servidor");
    expect(out.args[2]).toContain("exec claude --resume abc");
    expect(out.args.join(" ")).not.toContain("-R");
  });

  it("with a bridge, opens the reverse tunnel before naming the host", () => {
    const out = sshLaunch({
      ...base,
      bridge: { port: 51515, token: "t0k3n", ptyId: "{{YARD_PTY_ID}}" },
    });
    expect(out.args[1]).toBe("-R");
    expect(out.args[2]).toContain(":127.0.0.1:51515");
    expect(out.args[3]).toBe("servidor");
  });

  it("names the terminal with the placeholder the backend fills in", () => {
    const out = sshLaunch({
      ...base,
      bridge: { port: 51515, token: "t0k3n", ptyId: "{{YARD_PTY_ID}}" },
    });
    expect(out.args[4]).toContain("YARD_PTY_ID='{{YARD_PTY_ID}}'");
  });

  it("still runs the CLI in the remote folder, bridge or no bridge", () => {
    const withBridge = sshLaunch({
      ...base,
      bridge: { port: 51515, token: "t", ptyId: "x" },
    });
    expect(withBridge.args[4]).toContain("cd '/home/alguem/repo'");
    expect(withBridge.args[4]).toContain("exec claude --resume abc");
  });
});
