/**
 * The in-world tooltip used to be a CSS `::after` on the control itself. That
 * shape had two ways of losing text that no stylesheet can fix: inside a
 * scrollport (the sidebar tree, the bench body, the tab strip) the balloon was
 * clipped by the container, and inside a stacking context (the title bar's
 * `backdrop-filter`) a panel painted later covered it. So the balloon is one
 * fixed element in `<body>`, and *where it goes* and *when it shows* are the
 * rules below, pure, so the geometry can be checked with numbers and the
 * hover/focus/Esc contract (WCAG 1.4.13) with a state machine.
 */
import { describe, expect, it } from "vitest";

import { placeTip, tipRequest, tipStep, TIP_MARGIN, type TipState } from "./tip";

const attrs = (map: Record<string, string>) => ({
  getAttribute: (name: string) => (name in map ? map[name] : null),
});

describe("what the control asks for", () => {
  it("reads the text and defaults to a centred balloon below the control", () => {
    expect(tipRequest(attrs({ "data-tip": "Fechar" }))).toEqual({
      text: "Fechar",
      side: "bottom",
      at: "center",
      wrap: false,
    });
  });

  it("an empty or blank hint is no hint, nothing opens", () => {
    expect(tipRequest(attrs({}))).toBeNull();
    expect(tipRequest(attrs({ "data-tip": "" }))).toBeNull();
    expect(tipRequest(attrs({ "data-tip": "   " }))).toBeNull();
  });

  it("honours the anchoring, the side and the wrap variants", () => {
    expect(
      tipRequest(
        attrs({ "data-tip": "x", "data-tip-at": "right", "data-tip-side": "top", "data-tip-wrap": "" }),
      ),
    ).toEqual({ text: "x", side: "top", at: "right", wrap: true });
    expect(tipRequest(attrs({ "data-tip": "x", "data-tip-side": "left" }))?.side).toBe("left");
    expect(tipRequest(attrs({ "data-tip": "x", "data-tip-side": "right" }))?.side).toBe("right");
    expect(tipRequest(attrs({ "data-tip": "x", "data-tip-at": "left" }))?.at).toBe("left");
  });

  it("an unknown variant falls back to the default instead of breaking the balloon", () => {
    expect(tipRequest(attrs({ "data-tip": "x", "data-tip-at": "middle", "data-tip-side": "up" }))).toEqual({
      text: "x",
      side: "bottom",
      at: "center",
      wrap: false,
    });
  });
});

describe("where the balloon goes", () => {
  const vp = { width: 800, height: 600 };
  const tip = { width: 100, height: 30 };
  const box = (left: number, top: number, width = 20, height = 20) => ({ left, top, width, height });
  const below = { side: "bottom", at: "center" } as const;

  it("opens below the control, centred on it", () => {
    expect(placeTip(box(100, 50), tip, vp, below)).toEqual({ x: 60, y: 70, side: "bottom" });
  });

  it("flips above when there is no room below", () => {
    expect(placeTip(box(100, 580), tip, vp, below)).toEqual({ x: 60, y: 550, side: "top" });
  });

  it("keeps the asked side when neither side has room: a balloon half off-screen beats none", () => {
    expect(placeTip(box(100, 10), tip, { width: 800, height: 40 }, below)).toEqual({
      x: 60,
      y: 30,
      side: "bottom",
    });
  });

  it("slides inside the window instead of dying off the left edge", () => {
    expect(placeTip(box(2, 50), tip, vp, below).x).toBe(TIP_MARGIN);
  });

  it("slides inside the window instead of dying off the right edge", () => {
    expect(placeTip(box(790, 50), tip, vp, below).x).toBe(800 - TIP_MARGIN - 100);
  });

  it("a balloon wider than the window hugs the left margin so the text starts readable", () => {
    expect(placeTip(box(400, 50), { width: 900, height: 30 }, vp, below).x).toBe(TIP_MARGIN);
  });

  it("`at: left` lines the balloon's left edge up with the control's", () => {
    expect(placeTip(box(100, 50), tip, vp, { side: "bottom", at: "left" }).x).toBe(100);
  });

  it("`at: right` lines the right edges up", () => {
    expect(placeTip(box(100, 50), tip, vp, { side: "bottom", at: "right" }).x).toBe(20);
  });

  it("`side: top` opens above, and flips below when the control touches the top", () => {
    expect(placeTip(box(100, 200), tip, vp, { side: "top", at: "center" })).toEqual({
      x: 60,
      y: 170,
      side: "top",
    });
    expect(placeTip(box(100, 2), tip, vp, { side: "top", at: "center" })).toEqual({
      x: 60,
      y: 22,
      side: "bottom",
    });
  });

  it("`side: right` exits sideways at the control's height", () => {
    expect(placeTip(box(100, 50), tip, vp, { side: "right", at: "center" })).toEqual({
      x: 120,
      y: 45,
      side: "right",
    });
  });

  it("sideways near the right edge, it comes out on the left instead", () => {
    expect(placeTip(box(790, 50, 10), tip, vp, { side: "right", at: "center" })).toEqual({
      x: 690,
      y: 45,
      side: "left",
    });
  });

  it("`side: left` exits to the left, and flips right when the control touches the left edge", () => {
    expect(placeTip(box(300, 50), tip, vp, { side: "left", at: "center" })).toEqual({
      x: 200,
      y: 45,
      side: "left",
    });
    expect(placeTip(box(4, 50), tip, vp, { side: "left", at: "center" })).toEqual({
      x: 24,
      y: 45,
      side: "right",
    });
  });

  it("sideways, it slides vertically to stay inside the window", () => {
    expect(placeTip(box(100, 0, 20, 10), tip, vp, { side: "right", at: "center" }).y).toBe(TIP_MARGIN);
    expect(placeTip(box(100, 595, 20, 5), tip, vp, { side: "right", at: "center" }).y).toBe(
      600 - TIP_MARGIN - 30,
    );
  });
});

describe("when the balloon shows", () => {
  const idle: TipState<string> = { phase: "idle" };
  const arrive = (anchor: string | null, extra: { inBalloon?: boolean; buttons?: number } = {}) => ({
    type: "arrive" as const,
    anchor,
    inBalloon: extra.inBalloon ?? false,
    buttons: extra.buttons ?? 0,
  });

  it("resting the pointer on a control arms the balloon, and the delay opens it", () => {
    const armed = tipStep(idle, arrive("a"));
    expect(armed).toEqual({ phase: "armed", anchor: "a" });
    expect(tipStep(armed, { type: "timer" })).toEqual({ phase: "open", anchor: "a" });
  });

  it("moving within the same control changes nothing", () => {
    const open: TipState<string> = { phase: "open", anchor: "a" };
    expect(tipStep(open, arrive("a"))).toBe(open);
    const armed: TipState<string> = { phase: "armed", anchor: "a" };
    expect(tipStep(armed, arrive("a"))).toBe(armed);
  });

  it("the pointer may cross onto the balloon itself (WCAG 1.4.13, hoverable)", () => {
    const open: TipState<string> = { phase: "open", anchor: "a" };
    expect(tipStep(open, arrive(null, { inBalloon: true }))).toBe(open);
  });

  it("leaving for anything else closes it; leaving for another control arms that one", () => {
    const open: TipState<string> = { phase: "open", anchor: "a" };
    expect(tipStep(open, arrive(null))).toEqual(idle);
    expect(tipStep(open, arrive("b"))).toEqual({ phase: "armed", anchor: "b" });
    expect(tipStep(open, { type: "leave" })).toEqual(idle);
  });

  it("a held button never opens a balloon: that is a drag, not a hover", () => {
    expect(tipStep(idle, arrive("a", { buttons: 1 }))).toEqual(idle);
    const armed: TipState<string> = { phase: "armed", anchor: "a" };
    expect(tipStep(armed, arrive("a", { buttons: 1 }))).toEqual(idle);
  });

  it("Esc closes it and keeps it closed while the pointer stays on that control", () => {
    const open: TipState<string> = { phase: "open", anchor: "a" };
    const dismissed = tipStep(open, { type: "close" });
    expect(dismissed).toEqual({ phase: "dismissed", anchor: "a" });
    expect(tipStep(dismissed, arrive("a"))).toBe(dismissed);
    expect(tipStep(dismissed, { type: "timer" })).toBe(dismissed);
    // Moving on releases it: another control, or nothing at all.
    expect(tipStep(dismissed, arrive("b"))).toEqual({ phase: "armed", anchor: "b" });
    expect(tipStep(dismissed, arrive(null))).toEqual(idle);
  });

  it("a press closes it the same way: the click already said what the hint was saying", () => {
    const armed: TipState<string> = { phase: "armed", anchor: "a" };
    expect(tipStep(armed, { type: "close" })).toEqual({ phase: "dismissed", anchor: "a" });
    expect(tipStep(idle, { type: "close" })).toEqual(idle);
  });

  it("a late timer means nothing once the balloon was closed", () => {
    expect(tipStep(idle, { type: "timer" })).toBe(idle);
    const open: TipState<string> = { phase: "open", anchor: "a" };
    expect(tipStep(open, { type: "timer" })).toBe(open);
  });

  it("keyboard focus opens the same balloon, and focus leaving takes it away", () => {
    const armed = tipStep(idle, { type: "focus", anchor: "a" });
    expect(armed).toEqual({ phase: "armed", anchor: "a" });
    const open = tipStep(armed, { type: "timer" });
    expect(tipStep(open, { type: "blur", anchor: "a" })).toEqual(idle);
  });

  it("focus leaving some other control does not touch the balloon under the pointer", () => {
    const open: TipState<string> = { phase: "open", anchor: "a" };
    expect(tipStep(open, { type: "blur", anchor: "b" })).toBe(open);
  });

  it("focus arriving is a fresh intent: it releases an Esc, even on the same control", () => {
    const dismissed: TipState<string> = { phase: "dismissed", anchor: "a" };
    expect(tipStep(dismissed, { type: "focus", anchor: "b" })).toEqual({ phase: "armed", anchor: "b" });
    expect(tipStep(dismissed, { type: "focus", anchor: "a" })).toEqual({ phase: "armed", anchor: "a" });
  });
});
