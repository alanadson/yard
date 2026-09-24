/**
 * Why a tab that comes back resumes its renderer by hand.
 *
 * xterm 5.5 pauses a terminal's renderer only through an IntersectionObserver,
 * and the observer reports the way back after the reveal frame has already
 * been painted: a tab moved out of the viewport while it was hidden would
 * come back showing the screen it had when it left, for a frame or two, and
 * only then the output it received while away (measured in Edge). The one
 * way to resume inside the reveal frame is the observer's own handler, which
 * is private. So the call has to stay harmless if a future xterm drops it (a
 * no-op, never an exception in the middle of a tab switch), and the xterm
 * this app ships has to be checked for it, or that no-op would bring the
 * stale frame back without anybody noticing.
 */
import { describe, expect, it } from "vitest";

import xtermBundle from "@xterm/xterm/lib/xterm.js?raw";
import { resumeRenderer } from "./xtermResume";

/** What xterm 5.5's own handler does with an observer entry, and nothing else. */
class FakeRenderService {
  _isPaused = true;
  _handleIntersectionChange(entry: { isIntersecting?: boolean; intersectionRatio: number }) {
    this._isPaused =
      entry.isIntersecting === undefined ? entry.intersectionRatio === 0 : !entry.isIntersecting;
  }
}

describe("resumeRenderer", () => {
  it("unpauses a paused renderer through xterm's own intersection handler", () => {
    const renderService = new FakeRenderService();
    resumeRenderer({ _core: { _renderService: renderService } });
    expect(renderService._isPaused).toBe(false);
  });

  it("does nothing, and throws nothing, when the terminal has no such handler", () => {
    const shapes: unknown[] = [
      null,
      undefined,
      {},
      { _core: null },
      { _core: {} },
      { _core: { _renderService: null } },
      { _core: { _renderService: {} } },
      { _core: { _renderService: { _handleIntersectionChange: "gone" } } },
    ];
    for (const term of shapes) {
      expect(() => resumeRenderer(term)).not.toThrow();
    }
  });
});

describe("the xterm this app ships", () => {
  it("still keeps the handler where the resume looks for it", () => {
    // The public terminal keeps its core as `_core`, the core its render
    // service as `_renderService`, and the service's observer callback is
    // the one place that clears the paused flag.
    expect(xtermBundle).toContain("this._core=this.register(new ");
    expect(xtermBundle).toContain("this._renderService=this.register(");
    expect(xtermBundle).toMatch(/_handleIntersectionChange\(\w+\)\{this\._isPaused=/);
  });
});
