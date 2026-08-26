/**
 * Agents print `src/lib/foo.ts:42` and `http://localhost:5173` all day, and
 * until now nothing in the terminal was clickable. The matcher is deliberately
 * conservative: a false positive is an underline over prose, a false negative
 * is nothing — but a Ctrl+click that opens the wrong file teaches the user to
 * stop trusting the underline.
 */
import { describe, expect, it } from "vitest";

import { findLinks, linkRange } from "./termLinks";

describe("findLinks — web addresses", () => {
  it("finds an http(s) address with its exact span", () => {
    const line = "  ➜  Local:   http://localhost:5173/  ";
    const [m] = findLinks(line);
    expect(m).toMatchObject({ kind: "url", url: "http://localhost:5173/" });
    expect(line.slice(m.start, m.end)).toBe("http://localhost:5173/");
    expect(findLinks(line)).toHaveLength(1);
  });
});

describe("findLinks — file paths", () => {
  it("finds a relative path with the :line:col the agent printed after it", () => {
    const line = "  edited src/lib/blocked.ts:42:7 and moved on";
    const [m] = findLinks(line);
    expect(m).toMatchObject({ kind: "path", path: "src/lib/blocked.ts", line: 42, col: 7 });
    expect(line.slice(m.start, m.end)).toBe("src/lib/blocked.ts:42:7");
  });
});

describe("findLinks — the shapes compilers print", () => {
  it("reads tsc's `file(line,col)` and rustc's `--> file:line:col`", () => {
    const tsc = findLinks("src/lib/x.ts(12,3): error TS2322: Type 'a'")[0];
    expect(tsc).toMatchObject({ path: "src/lib/x.ts", line: 12, col: 3, text: "src/lib/x.ts(12,3)" });
    const rustc = findLinks("  --> src-tauri/src/pty/mod.rs:88:5")[0];
    expect(rustc).toMatchObject({ path: "src-tauri/src/pty/mod.rs", line: 88, col: 5 });
    const only = findLinks("at src/app.tsx:7")[0];
    expect(only).toMatchObject({ path: "src/app.tsx", line: 7 });
    expect(only.col).toBeUndefined();
  });

  it("accepts Windows drives, ./ and ../ prefixes and the Git Bash /c/ form", () => {
    expect(findLinks(String.raw`wrote C:\Users\me\proj\out.txt`)[0]).toMatchObject({
      path: String.raw`C:\Users\me\proj\out.txt`,
    });
    expect(findLinks("see ./notes/plan.md and ../shared/x")[0].path).toBe("./notes/plan.md");
    expect(findLinks("see ./notes/plan.md and ../shared/x")[1].path).toBe("../shared/x");
    expect(findLinks("in /c/Workspace/Code/yard/src")[0].path).toBe("/c/Workspace/Code/yard/src");
  });

  it("takes a bare file name only when it carries a real extension", () => {
    expect(findLinks("updated package.json and README.md")).toMatchObject([
      { path: "package.json" },
      { path: "README.md" },
    ]);
    expect(findLinks("open Makefile please")).toEqual([]);
  });
});

describe("findLinks — punctuation and prose", () => {
  it("drops the sentence punctuation glued after a path or an address", () => {
    expect(findLinks("(see src/lib/x.ts).")[0].text).toBe("src/lib/x.ts");
    expect(findLinks("edited src/lib/x.ts:42, then")[0]).toMatchObject({ line: 42, text: "src/lib/x.ts:42" });
    expect(findLinks("fixed in src/lib/x.ts:12.")[0]).toMatchObject({ line: 12, text: "src/lib/x.ts:12" });
    expect(findLinks("docs at https://example.com/a/b, ok")[0].url).toBe("https://example.com/a/b");
    expect(findLinks("wiki: https://en.wikipedia.org/wiki/X_(Y)")[0].url).toBe(
      "https://en.wikipedia.org/wiki/X_(Y)",
    );
  });

  it("does not underline versions, clock times, e.g., and/or or an e-mail", () => {
    expect(findLinks("vite v7.0.4 ready in 312 ms at 04:17")).toEqual([]);
    expect(findLinks("[12:30:45] done, e.g. this and/or that; write me at dev@example.com")).toEqual([]);
    // A bare word ending in a top-level domain is a site name, not a file —
    // and not an address either: no scheme, no port, nothing to open.
    expect(findLinks("pushed to github.com and example.org, ok")).toEqual([]);
  });

  it("keeps a path and an address on the same row apart, in order", () => {
    const line = "served src/index.html at http://127.0.0.1:8080/index.html";
    expect(findLinks(line).map((m) => m.kind)).toEqual(["path", "url"]);
    expect(findLinks(line)[1].url).toBe("http://127.0.0.1:8080/index.html");
  });
});

describe("linkRange — from string offsets to xterm's buffer cells", () => {
  it("converts a half-open 0-based span into xterm's 1-based, inclusive range on the same row", () => {
    const [m] = findLinks("at src/x.ts:7 now");
    // "src/x.ts:7" starts at offset 3 (cell 4) and its last char is offset 12 (cell 13).
    expect(linkRange(m, 5)).toEqual({ start: { x: 4, y: 5 }, end: { x: 13, y: 5 } });
  });
});
