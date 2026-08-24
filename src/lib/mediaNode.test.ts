/**
 * A media card (§52) points at a file on disk, and the protocol that serves
 * those bytes (`yardfile://`, `src-tauri/src/media.rs`) never takes a bare
 * path: it takes a **root the app opened** plus a path resolved under it. So
 * the whole question this module answers is where to cut an absolute path in
 * two — and getting that cut wrong is not a cosmetic bug, it is a card that
 * shows "arquivo não encontrado" for a file the user can see in Explorer.
 *
 * The rule: inside the project, the path is relative to it and the card stays
 * portable (a score applied in another project resolves against the new one).
 * Outside, the card carries its own root, because there is nothing else it
 * could be relative to.
 */
import { describe, expect, it } from "vitest";

import { mediaNodeName, splitForRoot } from "./mediaNode";
import type { CanvasItem } from "./canvas";

describe("splitForRoot", () => {
  const project = "C:\\Workspace\\Code\\yard";

  it("keeps a file inside the project relative to it", () => {
    // No `root` on the item: that is what makes the card survive a score
    // applied in another checkout of the same repository.
    expect(splitForRoot(`${project}\\docs\\shot.png`, project)).toEqual({
      path: "docs/shot.png",
    });
  });

  it("writes the path with forward slashes, whatever the OS gave", () => {
    // The backend's `resolve` and every other path in this app are `/`
    // separated. A stored `docs\\shot.png` would only work on Windows.
    const out = splitForRoot(`${project}\\a\\b\\c.png`, project);
    expect(out.path).toBe("a/b/c.png");
  });

  it("gives a file outside the project a root of its own", () => {
    expect(splitForRoot("D:\\fotos\\ref.png", project)).toEqual({
      root: "D:/fotos",
      path: "ref.png",
    });
  });

  it("does the same when there is no project at all — a board", () => {
    // A quadro belongs to no project, so every card on it carries its root.
    expect(splitForRoot("D:\\fotos\\ref.png", "")).toEqual({
      root: "D:/fotos",
      path: "ref.png",
    });
  });

  it("is not fooled by a sibling folder that starts with the project's name", () => {
    // `yard-old` is not inside `yard`. Comparing prefixes without the
    // separator would file it as `-old/x.png` — a path that resolves to
    // nothing and takes the whole card down with it.
    const out = splitForRoot("C:\\Workspace\\Code\\yard-old\\x.png", project);
    expect(out).toEqual({ root: "C:/Workspace/Code/yard-old", path: "x.png" });
  });

  it("matches the project root case-insensitively on Windows paths", () => {
    // The dialog hands back `C:\workspace\...` where the project says
    // `C:\Workspace\...`; the same folder, and the user should not be able to
    // tell the difference from the card.
    expect(splitForRoot(`c:\\workspace\\code\\yard\\a.png`, project)).toEqual({
      path: "a.png",
    });
  });
});

describe("mediaNodeName", () => {
  const base: Extract<CanvasItem, { type: "media" }> = {
    id: "m1",
    type: "media",
    x: 0,
    y: 0,
    w: 320,
    h: 240,
    path: "docs/diagrama final.png",
    color: "#fff",
  };

  it("falls back to the file's own name", () => {
    expect(mediaNodeName(base)).toBe("diagrama final.png");
  });

  it("prefers the name the user pinned", () => {
    expect(mediaNodeName({ ...base, name: "Arquitetura" })).toBe("Arquitetura");
  });
});
