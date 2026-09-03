/**
 * A card on a board can come from any front of any project. The front is
 * what tells two "claude" cards apart, so it needs a colour that stays the
 * same across reloads, a way to be found from a working folder, and a rule
 * for when the badge is worth the pixels at all.
 */
import { describe, expect, it } from "vitest";

import { frontBadge, frontColor, frontOfPath, type FrontRef } from "./floorColor";

const fronts: FrontRef[] = [
  { id: "g1", name: "chão", worktreePath: "C:\\Workspace\\yard" },
  { id: "g2", name: "fix-login", worktreePath: "C:\\Workspace\\yard\\.yard\\floors\\fix-login" },
  { id: "g3", name: "outro", worktreePath: "D:\\repos\\outro" },
];

describe("frontColor", () => {
  it("is stable for the same front and differs between fronts", () => {
    expect(frontColor({ id: "g2" })).toBe(frontColor({ id: "g2" }));
    expect(frontColor({ id: "g2" })).not.toBe(frontColor({ id: "g3" }));
  });

  it("is a colour the board already paints with", () => {
    expect(frontColor({ id: "anything" })).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("a chosen colour wins over the hash", () => {
    expect(frontColor({ id: "g2", color: "#123456" })).toBe("#123456");
  });
});

describe("frontOfPath", () => {
  it("finds the deepest worktree a folder sits in", () => {
    expect(frontOfPath("C:\\Workspace\\yard\\.yard\\floors\\fix-login\\src", fronts)?.id).toBe("g2");
    expect(frontOfPath("C:\\Workspace\\yard\\src", fronts)?.id).toBe("g1");
  });

  it("ignores case on a Windows drive and either separator", () => {
    expect(frontOfPath("c:/workspace/YARD/src", fronts)?.id).toBe("g1");
  });

  it("does not mistake a sibling folder for the worktree", () => {
    expect(frontOfPath("C:\\Workspace\\yard-old\\src", fronts)).toBeNull();
    expect(frontOfPath("E:\\elsewhere", fronts)).toBeNull();
  });
});

describe("frontBadge", () => {
  const ground = fronts[0];
  const front = fronts[1];

  it("says nothing on a project canvas when the card lives in the group's own front", () => {
    expect(frontBadge(front, front, false)).toBeNull();
  });

  it("names the front on a board, where every card comes from somewhere else", () => {
    expect(frontBadge(ground, null, true)).toBe(ground);
  });

  it("names a card that runs in another front than the group's", () => {
    expect(frontBadge(front, ground, false)).toBe(front);
  });

  it("has nothing to say for a folder outside every front", () => {
    expect(frontBadge(null, ground, true)).toBeNull();
  });
});
