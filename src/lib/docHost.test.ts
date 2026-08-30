/**
 * Where an opened file lands is the difference between a document that sits
 * next to the agent editing it and a modal window over everything else.
 *
 * The rule earned a module of its own the day the workspace could show no
 * group at all: with no pane to hold a tab bar the editor fell back to the
 * big overlay, so a click on a file in the tree answered with a centred
 * window the user had to dismiss — for a project that has a perfectly good
 * place to put a tab, it just had none open yet.
 */
import { describe, expect, it } from "vitest";

import { docHost } from "./docHost";

describe("docHost", () => {
  it("a group showing the grid has a tab bar: the file is a tab in the pane", () => {
    expect(docHost({ groupId: "g1", surface: "grid", projectId: "p1" })).toBe("pane");
  });

  it("with no group open the project gets one, instead of the modal window", () => {
    expect(docHost({ groupId: null, surface: null, projectId: "p1" })).toBe("group");
  });

  it("the canvas has no tab bar to land in, so there the file is still the overlay", () => {
    expect(docHost({ groupId: "g1", surface: "canvas", projectId: "p1" })).toBe("overlay");
  });

  it("no project to own a group leaves the overlay as the only surface", () => {
    expect(docHost({ groupId: null, surface: null, projectId: null })).toBe("overlay");
  });
});
