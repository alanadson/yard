/**
 * A path printed by a process is relative to *that process's* folder, not to
 * the project — a `cargo` inside `src-tauri/` says `src/pty/mod.rs`, and the
 * file the user wants is `src-tauri/src/pty/mod.rs` seen from the root. The
 * editor only reads inside a root (`explorer::resolve` refuses `..` and
 * drives), so the decision of which root and which relative path has to be
 * right here, before anything is opened.
 */
import { describe, expect, it } from "vitest";

import { planOpen, resolveTarget } from "./termLinkOpen";
import type { LinkMatch } from "./termLinks";

const path = (p: string, line?: number, col?: number): LinkMatch => ({
  start: 0,
  end: p.length,
  text: p,
  kind: "path",
  path: p,
  ...(line !== undefined ? { line } : {}),
  ...(col !== undefined ? { col } : {}),
});

const ROOT = String.raw`C:\Workspace\Code\yard`;

describe("resolveTarget", () => {
  it("hands a web address over untouched", () => {
    const m: LinkMatch = { start: 0, end: 5, text: "x", kind: "url", url: "http://localhost:5173/" };
    expect(resolveTarget(m, { cwd: ROOT, root: ROOT })).toEqual({ kind: "url", url: "http://localhost:5173/" });
  });

  it("resolves a relative path against the terminal's folder, then says it from the root", () => {
    expect(resolveTarget(path("src/lib/x.ts", 42, 7), { cwd: ROOT, root: ROOT })).toEqual({
      kind: "file",
      root: ROOT,
      path: "src/lib/x.ts",
      line: 42,
      col: 7,
    });
    const inside = String.raw`${ROOT}\src-tauri`;
    expect(resolveTarget(path("src/pty/mod.rs", 88), { cwd: inside, root: ROOT })).toMatchObject({
      kind: "file",
      path: "src-tauri/src/pty/mod.rs",
      line: 88,
    });
    expect(resolveTarget(path("../src/lib/x.ts"), { cwd: inside, root: ROOT })).toMatchObject({
      path: "src/lib/x.ts",
    });
    expect(resolveTarget(path("./Cargo.toml"), { cwd: inside, root: ROOT })).toMatchObject({
      path: "src-tauri/Cargo.toml",
    });
  });
});

describe("resolveTarget — absolute paths", () => {
  it("brings an absolute path inside the root back to the root's relative form, whatever the case and slashes", () => {
    expect(resolveTarget(path("c:/workspace/code/YARD/src/x.ts"), { cwd: ROOT, root: ROOT })).toMatchObject({
      kind: "file",
      root: ROOT,
      path: "src/x.ts",
    });
    expect(
      resolveTarget(path("/c/Workspace/Code/yard/docs/a.md"), { cwd: String.raw`C:\elsewhere`, root: ROOT }),
    ).toMatchObject({ kind: "file", path: "docs/a.md" });
  });

  it("sends a path outside every root to the system, and gives up on a POSIX path it cannot place", () => {
    expect(resolveTarget(path(String.raw`C:\Users\me\shot.png`), { cwd: ROOT, root: ROOT })).toEqual({
      kind: "external",
      path: String.raw`C:\Users\me\shot.png`,
    });
    expect(resolveTarget(path("../../other/x.ts"), { cwd: String.raw`${ROOT}\src`, root: ROOT })).toEqual({
      kind: "external",
      path: String.raw`C:\Workspace\Code\other\x.ts`,
    });
    expect(resolveTarget(path("/home/me/x.ts"), { cwd: ROOT, root: ROOT })).toBeNull();
    // A board's card has no project root: only the system can open it.
    expect(resolveTarget(path("src/x.ts"), { cwd: String.raw`D:\repo`, root: null })).toEqual({
      kind: "external",
      path: String.raw`D:\repo\src\x.ts`,
    });
  });
});

describe("planOpen", () => {
  const term = { id: "t1", groupId: "g1", slot: 2, surface: "grid" as const };

  it("opens an address as a browser tab of the same pane, or as a portal wired to the card", () => {
    const url = { kind: "url" as const, url: "http://localhost:5173/" };
    expect(planOpen(url, term)).toEqual({ op: "browser", groupId: "g1", slot: 2, url: url.url });
    expect(planOpen(url, { ...term, surface: "canvas" })).toEqual({
      op: "portal",
      groupId: "g1",
      terminalId: "t1",
      url: url.url,
    });
  });

  it("opens a file as an editor tab at the line, and an outside path through the system", () => {
    expect(planOpen({ kind: "file", root: ROOT, path: "src/x.ts", line: 3, col: 9 }, term)).toEqual({
      op: "editor",
      root: ROOT,
      path: "src/x.ts",
      line: 3,
    });
    expect(planOpen({ kind: "external", path: String.raw`C:\x.png` }, term)).toEqual({
      op: "external",
      path: String.raw`C:\x.png`,
    });
  });
});
