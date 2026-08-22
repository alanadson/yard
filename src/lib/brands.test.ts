/**
 * Which mark a terminal gets — the cases that come from the machine, not from
 * the picker: an npm shim (`claude.cmd`), a full Windows path, a binary whose
 * name is not the catalog id (`gh-copilot` installs `copilot`).
 */
import { describe, expect, it } from "vitest";

import { brandById, brandOf } from "./brands";

describe("brandOf", () => {
  it("reads the catalog id first", () => {
    expect(brandOf({ agentId: "cursor-agent", program: "cursor-agent" })).toBe(
      "cursor",
    );
    expect(brandOf({ agentId: "gh-copilot", program: "copilot.cmd" })).toBe(
      "copilot",
    );
  });

  it("falls back to the program when there is no id", () => {
    expect(brandOf({ program: "codex" })).toBe("codex");
    expect(brandOf({ agentId: null, program: "grok.cmd" })).toBe("grok");
  });

  it("strips the directory and the Windows extension", () => {
    expect(
      brandOf({ program: "C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd" }),
    ).toBe("claude");
    expect(
      brandOf({ program: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" }),
    ).toBe("powershell");
    expect(brandOf({ program: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe(
      "bash",
    );
  });

  it("does not care about case", () => {
    expect(brandOf({ program: "C:\\Windows\\System32\\CMD.EXE" })).toBe("cmd");
  });

  it("returns null for what has no mark of its own", () => {
    // Aider is in the catalog and has no public logo: the generic glyph
    // answers for it instead of another company's mark.
    expect(brandOf({ agentId: "aider", program: "aider" })).toBeNull();
    expect(brandOf({ program: "meu-script.exe" })).toBeNull();
  });
});

describe("brandById", () => {
  it("serves the rows that are not terminals yet", () => {
    expect(brandById("pwsh")).toBe("powershell"); // ShellOption
    expect(brandById("opencode")).toBe("opencode"); // AgentInfo
    expect(brandById("claude")).toBe("claude"); // usage provider
    expect(brandById(null)).toBeNull();
    expect(brandById("aider")).toBeNull();
  });
});
