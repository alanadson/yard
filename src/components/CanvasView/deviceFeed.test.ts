/**
 * A phone card on the canvas is a stream of screenshots: a base64 PNG over
 * IPC every 800 ms while it is live. That is the most expensive idle thing on
 * the board, so it must stop whenever nobody can see the result (the card
 * panned off the board, the window minimized or hidden, a surface covering
 * the canvas) and only run while there is a picture to look at.
 */
import { describe, expect, it } from "vitest";

import { screenFeed, type FeedInput } from "./deviceFeed";

const onBoard: FeedInput = {
  live: true,
  covered: false,
  faded: false,
  onScreen: true,
  windowShown: true,
};

describe("screenFeed", () => {
  it("a live phone on screen keeps streaming", () => {
    expect(screenFeed(onBoard)).toBe("loop");
  });

  it("a paused phone takes one frame and stops", () => {
    expect(screenFeed({ ...onBoard, live: false })).toBe("once");
  });

  it("a card panned off the board takes no screenshots, live or not", () => {
    expect(screenFeed({ ...onBoard, onScreen: false })).toBe("off");
    expect(screenFeed({ ...onBoard, onScreen: false, live: false })).toBe("off");
  });

  it("a hidden or minimized window takes no screenshots", () => {
    expect(screenFeed({ ...onBoard, windowShown: false })).toBe("off");
  });

  it("a covered or fading card takes no screenshots", () => {
    expect(screenFeed({ ...onBoard, covered: true })).toBe("off");
    expect(screenFeed({ ...onBoard, faded: true })).toBe("off");
  });
});
