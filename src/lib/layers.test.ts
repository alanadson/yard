/**
 * The regression this locks in: the surfaces that blank a portal (a modal,
 * the editor, the diff, Ao Vivo, the composer) were a hand-written list in
 * two components, and the list forgot the Busca and the notebook. A portal's
 * page is an OS window no z-index reaches, so opening Search over a browser
 * pane painted Google on top of the palette. The registry here already knew
 * every full-window surface for `Esc`; the portals now read the same one.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { anyLayerOpen, subscribeLayers, topLayer } from "./layers";
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { useLive } from "../stores/liveStore";
import { useNotes } from "../stores/notesStore";
import { useUI } from "../stores/uiStore";

beforeEach(() => {
  useUI.setState({ paletteOpen: false, modal: null, composerOpen: false });
  useEditor.setState({ open: false });
  useChanges.setState({ viewer: null });
  useLive.setState({ phase: "closed" });
  useNotes.setState({ open: false, place: { kind: "center" } });
});

describe("the layers that cover the window", () => {
  it("the Busca counts: with the palette open, the portals are covered", () => {
    expect(anyLayerOpen()).toBe(false);
    useUI.setState({ paletteOpen: true });
    expect(anyLayerOpen()).toBe(true);
    expect(topLayer()).toBe("busca");
  });

  it("every full-window surface covers, through the one registry", () => {
    useUI.setState({ modal: "preferences" });
    expect(anyLayerOpen()).toBe(true);
    useUI.setState({ modal: null, composerOpen: true });
    expect(anyLayerOpen()).toBe(true);
    useUI.setState({ composerOpen: false });
    useEditor.setState({ open: true });
    expect(anyLayerOpen()).toBe(true);
    useEditor.setState({ open: false });
    useChanges.setState({ viewer: { projectId: "p1", path: "a.ts" } });
    expect(anyLayerOpen()).toBe(true);
    useChanges.setState({ viewer: null });
    useLive.setState({ phase: "live" });
    expect(anyLayerOpen()).toBe(true);
    useLive.setState({ phase: "closed" });
    expect(anyLayerOpen()).toBe(false);
  });

  it("the notebook is a view, not a layer: in the centre it owns no Esc and blanks no portal", () => {
    // The centre replaces the grid and the canvas: there is no portal
    // mounted under it to blank, and the panels beside it keep their keys.
    useNotes.setState({ open: true, place: { kind: "center" } });
    expect(topLayer()).toBeNull();
    expect(anyLayerOpen()).toBe(false);
  });

  it("subscribeLayers wakes the subscriber when any covering surface opens or closes", () => {
    let woke = 0;
    const off = subscribeLayers(() => {
      woke += 1;
    });
    useUI.setState({ paletteOpen: true });
    expect(woke).toBeGreaterThan(0);
    const afterPalette = woke;
    useEditor.setState({ open: true });
    expect(woke).toBeGreaterThan(afterPalette);
    const afterEditor = woke;
    useLive.setState({ phase: "finding" });
    expect(woke).toBeGreaterThan(afterEditor);
    const afterLive = woke;
    useChanges.setState({ viewer: { projectId: "p1", path: "a.ts" } });
    expect(woke).toBeGreaterThan(afterLive);
    // Unsubscribed, silence: a portal that left the screen must not be woken.
    off();
    const quiet = woke;
    useUI.setState({ paletteOpen: false });
    expect(woke).toBe(quiet);
  });
});
