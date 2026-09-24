/**
 * A card on a board can come from any front of any project. The front is
 * what tells two "claude" cards apart, so it needs a colour that stays the
 * same across reloads, a way to be found from a working folder, and a rule
 * for when the badge is worth the pixels at all.
 */
import { describe, expect, it } from "vitest";

import {
  cardBadges,
  frontBadge,
  frontColor,
  frontOfPath,
  type CardBadge,
  type FrontRef,
} from "./floorColor";

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

/**
 * Every layout write re-reads every group, so the fronts come back as fresh
 * objects on each commit of the board (a pan settling, a note being typed, a
 * drag landing). A badge rebuilt from them is a new object too, and a new
 * object breaks the memo of every terminal card on the board: the badge has
 * to stay the very same object for as long as what it shows is the same.
 */
describe("cardBadges", () => {
  const cards = [
    { id: "t1", cwd: "C:\\Workspace\\yard\\src" },
    { id: "t2", cwd: "C:\\Workspace\\yard\\.yard\\floors\\fix-login" },
    { id: "t3", cwd: "E:\\elsewhere" },
  ];
  /** The same fronts as a re-parse hands them over: equal, never identical. */
  const reparsed = (): FrontRef[] => fronts.map((f) => ({ ...f }));

  it("gives each card on a board the name and colour of the front it runs in", () => {
    const out = cardBadges(cards, fronts, null, true);
    expect(out.get("t1")).toEqual({ id: "g1", name: "chão", color: frontColor(fronts[0]) });
    expect(out.get("t2")).toEqual({ id: "g2", name: "fix-login", color: frontColor(fronts[1]) });
  });

  it("leaves out a card outside every front, and one in the group's own front on a project canvas", () => {
    expect(cardBadges(cards, fronts, null, true).has("t3")).toBe(false);
    const onProject = cardBadges(cards, fronts, fronts[0], false);
    expect(onProject.has("t1")).toBe(false);
    expect(onProject.get("t2")?.id).toBe("g2");
  });

  it("keeps the previous badge object when a re-parse brings the same id, name and colour", () => {
    const first = cardBadges(cards, fronts, null, true);
    const second = cardBadges(cards, reparsed(), null, true, first);
    expect(second.get("t1")).toBe(first.get("t1"));
    expect(second.get("t2")).toBe(first.get("t2"));
  });

  it("hands over a new badge when the front is renamed, and only for the cards in it", () => {
    const first = cardBadges(cards, fronts, null, true);
    const renamed = reparsed();
    renamed[1].name = "fix-login-2";
    const second = cardBadges(cards, renamed, null, true, first);
    expect(second.get("t2")).not.toBe(first.get("t2"));
    expect(second.get("t2")?.name).toBe("fix-login-2");
    expect(second.get("t1")).toBe(first.get("t1"));
  });

  it("hands over a new badge when the front's colour changes", () => {
    const first = cardBadges(cards, fronts, null, true);
    const recoloured = reparsed();
    recoloured[1].color = "#123456";
    const second = cardBadges(cards, recoloured, null, true, first);
    expect(second.get("t2")).not.toBe(first.get("t2"));
    expect(second.get("t2")?.color).toBe("#123456");
  });

  it("hands over a new badge when the card now runs in another front", () => {
    const prev = new Map<string, CardBadge>([["t1", { id: "g3", name: "chão", color: frontColor(fronts[0]) }]]);
    const out = cardBadges(cards, fronts, null, true, prev);
    expect(out.get("t1")).not.toBe(prev.get("t1"));
    expect(out.get("t1")?.id).toBe("g1");
  });
});
