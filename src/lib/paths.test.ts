/**
 * `toOsPath` — the one boundary where a path leaves git's convention (`/`)
 * and goes to a shell. Three screens used to build
 * `${root}\${rel.replaceAll("/", "\\")}` by hand.
 */
import { describe, expect, it } from "vitest";

import { fileName, splitPath, toOsPath } from "./paths";

describe("splitPath", () => {
  it("splits folder and name, and handles the root", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib/", base: "a.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});

describe("fileName", () => {
  it("returns only the name", () => {
    expect(fileName("src/components/FileTree/index.tsx")).toBe("index.tsx");
  });
});

describe("toOsPath", () => {
  it("uses the backslash when the root is Windows", () => {
    expect(toOsPath("C:\\Workspace\\yard", "src/lib/a.ts")).toBe(
      "C:\\Workspace\\yard\\src\\lib\\a.ts",
    );
  });

  it("preserves the POSIX convention when the root is POSIX", () => {
    expect(toOsPath("/home/alan/yard", "src/lib/a.ts")).toBe("/home/alan/yard/src/lib/a.ts");
  });

  it("does not double the slash when the root already ends with one", () => {
    expect(toOsPath("C:\\Workspace\\yard\\", "a.ts")).toBe("C:\\Workspace\\yard\\a.ts");
    expect(toOsPath("/home/alan/yard/", "a.ts")).toBe("/home/alan/yard/a.ts");
  });

  it("an empty path returns the root itself", () => {
    expect(toOsPath("C:\\Workspace\\yard", "")).toBe("C:\\Workspace\\yard");
  });

  it("accepts a relative path that already comes with backslashes", () => {
    expect(toOsPath("C:\\yard", "src\\lib\\a.ts")).toBe("C:\\yard\\src\\lib\\a.ts");
  });

  /**
   * `git worktree list --porcelain` returns Windows paths with forward slashes.
   * The old rule ("does it have a `\`?") classified a floor's root as POSIX and
   * `explorer.exe /select,` got a `C:/…`, which selects nothing.
   */
  it("handles a Windows root written with forward slashes", () => {
    expect(toOsPath("C:/proj/.yard/floors/fix", "src/a.ts")).toBe(
      "C:\\proj\\.yard\\floors\\fix\\src\\a.ts",
    );
    expect(toOsPath("C:/proj", "")).toBe("C:\\proj");
  });

  it("recognizes a UNC network path", () => {
    expect(toOsPath("\\\\servidor\\repo", "src/a.ts")).toBe(
      "\\\\servidor\\repo\\src\\a.ts",
    );
  });

  /**
   * The live overlay lists files the agent touched outside the project (its own
   * memory, a screenshot in %TEMP%). Gluing those onto the root produced
   * `C:\proj\C:\Users\…`, which is a path to nothing.
   */
  it("returns an already rooted path without gluing it onto the root", () => {
    expect(toOsPath("C:/proj", "C:/Users/alan/.claude/memory/x.md")).toBe(
      "C:\\Users\\alan\\.claude\\memory\\x.md",
    );
    expect(toOsPath("C:/proj", "\\\\servidor\\share\\x.md")).toBe("\\\\servidor\\share\\x.md");
    expect(toOsPath("/home/alan/proj", "/tmp/captura.png")).toBe("/tmp/captura.png");
  });

  it("does not touch a backslash inside a POSIX path", () => {
    // On Linux `\` is an ordinary file-name character, not a separator.
    expect(toOsPath("/home/alan/yard", "src/a\\b.ts")).toBe("/home/alan/yard/src/a\\b.ts");
  });
});
