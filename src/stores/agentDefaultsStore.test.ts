/**
 * The fixed line of each CLI has to survive a reload — it is a setting, not a
 * dialog's state — and it is read at spawn time by code that has no `await` to
 * spare (`yard recruit`, a fan-out, the resume strip). Hence one kv key,
 * hydrated at boot, and a synchronous reader.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
import { DEFAULT_AGENT_CONFIG } from "../lib/agentDefaults";
import { KV_AGENT_DEFAULTS, useAgentDefaults } from "./agentDefaultsStore";

let written: Record<string, string>;

beforeEach(() => {
  written = {};
  setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      written[key] = value;
    },
  });
  useAgentDefaults.setState({ defaults: {} });
});

describe("load", () => {
  it("sifts what came back from the kv", async () => {
    await useAgentDefaults.getState().load({
      [KV_AGENT_DEFAULTS]: JSON.stringify({ claude: " --verbose ", codex: 7 }),
    });
    expect(useAgentDefaults.getState().defaults).toEqual({
      claude: { ...DEFAULT_AGENT_CONFIG, args: "--verbose" },
    });
  });
});

describe("setLine", () => {
  it("writes the line, and erasing it removes the agent from the record", async () => {
    useAgentDefaults.getState().setLine("claude", "--dangerously-skip-permissions");
    await vi.waitFor(() => expect(written[KV_AGENT_DEFAULTS]).toBeDefined());
    expect(JSON.parse(written[KV_AGENT_DEFAULTS])).toEqual({
      claude: "--dangerously-skip-permissions",
    });

    useAgentDefaults.getState().setLine("claude", "");
    await vi.waitFor(() =>
      expect(JSON.parse(written[KV_AGENT_DEFAULTS])).toEqual({}),
    );
    expect(useAgentDefaults.getState().defaults).toEqual({});
  });
});

describe("argvOf", () => {
  it("is what a spawn with no dialog adds to the command line", () => {
    useAgentDefaults.getState().setLine("claude", '--add-dir "C:\\meu projeto"');
    expect(useAgentDefaults.getState().argvOf("claude")).toEqual([
      "--add-dir",
      "C:\\meu projeto",
    ]);
  });

  it("an agent with nothing configured adds nothing", () => {
    expect(useAgentDefaults.getState().argvOf("codex")).toEqual([]);
    expect(useAgentDefaults.getState().argvOf(null)).toEqual([]);
  });
});

describe("setConfig", () => {
  it("changes one thing at a time and writes the record", async () => {
    useAgentDefaults.getState().setConfig("claude", { where: "wsl", distro: "Ubuntu" });
    useAgentDefaults.getState().setConfig("claude", { cache: "1h" });
    await vi.waitFor(() => expect(written[KV_AGENT_DEFAULTS]).toBeDefined());
    expect(JSON.parse(written[KV_AGENT_DEFAULTS])).toEqual({
      claude: { where: "wsl", distro: "Ubuntu", cache: "1h" },
    });
  });

  it("everything back to default leaves no row behind", async () => {
    useAgentDefaults.getState().setConfig("claude", { hidden: true });
    useAgentDefaults.getState().setConfig("claude", { hidden: false });
    await vi.waitFor(() =>
      expect(JSON.parse(written[KV_AGENT_DEFAULTS])).toEqual({}),
    );
  });
});

describe("envOf", () => {
  it("is what the cache choice puts in the process environment", () => {
    useAgentDefaults.getState().setConfig("claude", { cache: "1h" });
    expect(useAgentDefaults.getState().envOf("claude")).toEqual([
      ["ENABLE_PROMPT_CACHING_1H", "1"],
    ]);
    expect(useAgentDefaults.getState().envOf(null)).toEqual([]);
  });
});
