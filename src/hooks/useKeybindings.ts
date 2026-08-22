/**
 * Global shortcuts. Rule: nothing here may steal a key the terminal needs.
 * That is why everything uses Ctrl+Shift or combinations the shell does not
 * consume (Ctrl+T and Ctrl+W have no use in ConPTY).
 *
 * The exceptions are Ctrl+Tab and Ctrl+1..9, which switch tabs: `XTermView`
 * hands those keys back to the window instead of sending them to the PTY.
 */
import { useEffect } from "react";

import { jumpToAttention } from "../lib/attention";
import { closeDocTab } from "../lib/editorActions";
import { confirmCloseTerminal } from "../lib/lifecycle";
import { useBench } from "../stores/benchStore";
import { useBrowsers } from "../stores/browsersStore";
import { useChanges } from "../stores/changesStore";
import { useEditor } from "../stores/editorStore";
import { useLive } from "../stores/liveStore";
import {
  NOTES_TAB_ID,
  notesCenterVisible,
  notesOverlayVisible,
  useNotes,
} from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

/**
 * A surface covers the whole window (modal, editor, diff, "Live").
 *
 * While one of them is up, a global shortcut can only confuse: `Ctrl+T`
 * stacked a modal on top of the editor, and `Ctrl+Tab`/`Ctrl+1..9` switched
 * the tab of the terminal **behind** the overlay, with nothing changing on
 * screen. Each surface's `Esc` is the way out; until then, the window does
 * not listen.
 */
function fullscreenOpen(): boolean {
  return (
    useUI.getState().paletteOpen ||
    useUI.getState().modal !== null ||
    // The composer is one of these now: it is a dialog in the middle of the
    // window with a backdrop, not the corner box that used to let the panel
    // toggles keep working underneath it.
    useUI.getState().composerOpen ||
    useEditor.getState().open ||
    // Only the notebook's *overlay* counts. In the central place it is a
    // first-class view: the panel toggles, the palette and Ctrl+Shift+N
    // itself must keep working beside (and over) it.
    notesOverlayVisible() ||
    useChanges.getState().viewer !== null ||
    useLive.getState().phase !== "closed"
  );
}

/**
 * Is the target a real text field?
 *
 * The terminal is deliberately left **out** of this count: xterm receives what
 * is typed through a hidden `<textarea>` inside `.xterm-host`, and treating it
 * as a field would disable every shortcut in exactly the app's main case.
 */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (typeof el?.closest !== "function") return false;
  if (el.closest(".xterm-host")) return false;
  return !!el.closest(
    'input, textarea, select, [contenteditable="true"], .cm-editor',
  );
}

export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (fullscreenOpen()) return;
      // While typing in a field, `Ctrl+…` belongs to the field (or to the
      // browser): `Ctrl+B` collapsed the sidebar in the middle of a rename in
      // the tree.
      if (inTextField(e.target)) return;

      // Ctrl+Enter (and Ctrl+Shift+Enter) — the prompt composer, in the middle
      // of the window. Both open the same dialog; which key you press again
      // *inside* it is what decides whether the prompt is sent or merely left
      // on the CLI's command line. The window never sees the second press:
      // `telaCheiaAberta()` above already stepped aside for the composer.
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        e.preventDefault();
        // Point it at the CLI in focus. Without this the composer follows
        // `focusedTerminalId`, which is `null` after clicking a file tab or a
        // panel — the prompt then went to the scratch slot, and the box asked
        // for a destination that was plainly on screen behind it.
        const cli = focusedCli();
        if (cli) useUI.getState().setComposerTarget(cli);
        useUI.getState().setComposerOpen(true);
        return;
      }

      // Ctrl+P — Busca. Above the composer on purpose: looking for another
      // agent mid-prompt is exactly when you need it, and the draft survives.
      if (!e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        useUI.getState().openPalette();
        return;
      }

      // Ctrl+T — new terminal
      if (!e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        useUI.getState().openModal("new-terminal");
        return;
      }

      // Ctrl+Shift+P — preferences
      if (e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        useUI.getState().openModal("preferences");
        return;
      }

      // Ctrl+Shift+X — extensions (the same key VS Code means by it). Inside
      // a note or the editor the combination is strikethrough; those are text
      // fields, so `emCampoDeTexto` above already keeps this from firing.
      if (e.shiftKey && e.code === "KeyX") {
        e.preventDefault();
        useUI.getState().openModal("extensions");
        return;
      }

      // Ctrl+B — toggle sidebar
      if (!e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        useUI.getState().toggleSidebar();
        return;
      }

      // Ctrl+Shift+B — bench (tasks & prompts), the mirror of the left side
      if (e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        useBench.getState().toggle();
        return;
      }

      // Ctrl+Shift+E — project file tree (the same key as VS Code). Already
      // on the tab, it closes: this is a toggle.
      if (e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        useBench.getState().openTab("files");
        return;
      }

      // Ctrl+Shift+R — version control, in the bench. "R" for repository: the
      // Ctrl+Shift+G VS Code uses is already "next group of the project" here,
      // and stealing a shortcut that already exists is worse than teaching a
      // new one.
      if (e.shiftKey && e.code === "KeyR") {
        e.preventDefault();
        useBench.getState().openTab("scm");
        return;
      }

      // Ctrl+Shift+D — files/changes panel
      if (e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        useChanges.getState().toggle();
        return;
      }

      // Ctrl+Shift+A — the next agent that is waiting on you.
      // Works in any layout (it was canvas-only) and cuts through a focused
      // terminal on purpose: it is precisely from inside a CLI that one asks
      // "who stopped?". xterm does not complain about Ctrl+Shift+letter.
      if (e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        jumpToAttention();
        return;
      }

      // Ctrl+Shift+W — closes the active tab of the focused bar. With Shift,
      // and not every browser's Ctrl+W, because `Ctrl+W` deletes the previous
      // word in bash and in PSReadLine: the house rule is not to steal a key
      // the terminal uses. It is also what Windows Terminal does.
      if (e.shiftKey && e.code === "KeyW") {
        e.preventDefault();
        closeActiveTab();
        return;
      }

      // Ctrl+Shift+H — shortcut map
      if (e.shiftKey && e.code === "KeyH") {
        e.preventDefault();
        useUI.getState().openModal("shortcuts");
        return;
      }

      // Ctrl+Shift+N — Notes, the markdown notebook, summoned in the
      // place it lives in (overlay toggle, central toggle, or jump to its
      // pane tab). As an overlay it is a full surface: `telaCheiaAberta()`
      // above owns the keys then, and the view's own handler closes it.
      if (e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        useNotes.getState().toggleView();
        return;
      }

      // Ctrl+Shift+F — with a terminal in focus, find in its scrollback (the
      // window event; only the focused pane listens). Anywhere else it is the
      // key every IDE means by it: search the whole project, in the bench.
      if (e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        const cli = useUI.getState().focusedTerminalId;
        if (cli && useProjects.getState().terminal(cli)) {
          window.dispatchEvent(new CustomEvent("yard:find"));
        } else {
          useBench.getState().openTab("search");
        }
        return;
      }

      // Ctrl+1..9 — go to tab N of the focused bar. Not while the notebook
      // occupies the central area: the bars are behind it, and switching a
      // tab nobody can see changes nothing on screen.
      const digit = e.code.match(/^Digit([1-9])$/);
      if (digit && !e.shiftKey) {
        e.preventDefault();
        if (notesCenterVisible()) return;
        const ctx = focusedTabs();
        if (!ctx) return;
        const target = ctx.tabs[Number(digit[1]) - 1];
        if (target) activateTab(ctx.groupId, ctx.slot, target);
        return;
      }

      // Ctrl+Shift+1..6 — focus pane N. The bar shortcuts act on the focused
      // bar; until this key, reaching *another* pane was mouse-only — in the
      // app whose baseline scene is 2–6 terminals side by side.
      if (digit && e.shiftKey) {
        e.preventDefault();
        if (notesCenterVisible()) return;
        focusSlot(Number(digit[1]) - 1);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — next / previous tab
      if (e.code === "Tab") {
        e.preventDefault();
        if (notesCenterVisible()) return;
        const ctx = focusedTabs();
        if (!ctx || ctx.tabs.length < 2) return;
        const current = ctx.tabs.findIndex((t) => t.id === ctx.activeId);
        const step = e.shiftKey ? -1 : 1;
        const following =
          ctx.tabs[(current + step + ctx.tabs.length) % ctx.tabs.length];
        activateTab(ctx.groupId, ctx.slot, following);
        return;
      }

      // Ctrl+Shift+G — next group of the active project
      if (e.shiftKey && e.code === "KeyG") {
        e.preventDefault();
        const { activeProjectId, activeGroupId, groupsOf, setActiveGroup } =
          useProjects.getState();
        if (!activeProjectId) return;
        const list = groupsOf(activeProjectId);
        if (list.length < 2) return;
        const idx = list.findIndex((g) => g.id === activeGroupId);
        setActiveGroup(list[(idx + 1) % list.length].id);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Closes whatever is in front of the focused bar.
 *
 * Each kind of tab has its own way out: the CLI asks (closing erases history,
 * card and connections), the file asks if it is dirty, the page and the
 * notebook just leave the scene.
 */
function closeActiveTab() {
  const ctx = focusedTabs();
  const target = ctx?.tabs.find((t) => t.id === ctx.activeId) ?? ctx?.tabs[0];
  if (!target) return;
  if (target.kind === "term") void confirmCloseTerminal(target.id);
  else if (target.kind === "doc") void closeDocTab(target.id);
  else if (target.kind === "browser") useBrowsers.getState().close(target.id);
  else useNotes.getState().closeDock();
}

/**
 * The CLI a prompt written now would belong to.
 *
 * Usually the focused terminal, and that is the whole story while the cursor is
 * inside an xterm. But focus also sits on a file tab, on the tree or on a panel
 * — and in every one of those the bar underneath still has a CLI on it, which
 * is the one the user means. `null` only when there is genuinely none.
 */
function focusedCli(): string | null {
  const { focusedTerminalId } = useUI.getState();
  if (focusedTerminalId && useProjects.getState().terminal(focusedTerminalId)) {
    return focusedTerminalId;
  }
  const ctx = focusedTabs();
  if (!ctx) return null;
  const active = ctx.tabs.find((t) => t.id === ctx.activeId && t.kind === "term");
  return active?.id ?? ctx.tabs.find((t) => t.kind === "term")?.id ?? null;
}

/** One tab of a pane's bar — the four kinds the bar paints. */
interface TabRef {
  id: string;
  kind: "term" | "doc" | "browser" | "notes";
}

/**
 * Every tab of one bar, in the same order `TerminalPane` paints them: CLIs,
 * files, browsers, the notebook. Ctrl+Tab and Ctrl+1..9 walk exactly what is
 * on screen — a bar that paints four kinds of tab while the keyboard reaches
 * only two reads as a bug.
 */
function tabsInSlot(groupId: string, slot: number): TabRef[] {
  const all = useProjects.getState().terminalsOf(groupId);
  const docs = useEditor.getState().docs.filter((d) => d.groupId === groupId);
  const browsers = useBrowsers.getState().tabs.filter((b) => b.groupId === groupId);
  const place = useNotes.getState().place;
  const notesSlot =
    place.kind === "tab" && place.groupId === groupId ? place.slot : null;
  return [
    ...all
      .filter((t) => t.slot === slot)
      .map((t): TabRef => ({ id: t.id, kind: "term" })),
    ...docs
      .filter((d) => d.slot === slot)
      .map((d): TabRef => ({ id: d.id, kind: "doc" })),
    ...browsers
      .filter((b) => b.slot === slot)
      .map((b): TabRef => ({ id: b.id, kind: "browser" })),
    ...(notesSlot === slot ? [{ id: NOTES_TAB_ID, kind: "notes" } as TabRef] : []),
  ];
}

/**
 * Tabs of the focused bar, in the same order `TerminalPane` paints them.
 *
 * The slot comes from the focused terminal (not from `focusedSlot`) because
 * focus may still point at a pane that no longer exists; if nothing matches,
 * fall back to the group's first occupied bar.
 */
function focusedTabs(): {
  groupId: string;
  slot: number;
  activeId: string | null;
  tabs: TabRef[];
} | null {
  const { activeGroupId, terminalsOf, layoutOf, terminal } =
    useProjects.getState();
  if (!activeGroupId) return null;
  const everything = terminalsOf(activeGroupId);
  const docs = useEditor
    .getState()
    .docs.filter((d) => d.groupId === activeGroupId);
  const browsers = useBrowsers
    .getState()
    .tabs.filter((b) => b.groupId === activeGroupId);
  const place = useNotes.getState().place;
  const notesSlot =
    place.kind === "tab" && place.groupId === activeGroupId ? place.slot : null;
  if (
    everything.length === 0 &&
    docs.length === 0 &&
    browsers.length === 0 &&
    notesSlot === null
  ) {
    return null;
  }

  const { focusedTerminalId, focusedSlot } = useUI.getState();
  const focused = focusedTerminalId ? terminal(focusedTerminalId) : undefined;
  const preferred = focused?.groupId === activeGroupId ? focused.slot : focusedSlot;
  const occupied = (s: number) => tabsInSlot(activeGroupId, s).length > 0;
  const slot = occupied(preferred)
    ? preferred
    : (everything[0]?.slot ?? docs[0]?.slot ?? browsers[0]?.slot ?? notesSlot ?? 0);

  const tabs = tabsInSlot(activeGroupId, slot);

  // Same rule as `TerminalPane`: the saved tab only counts if it is still there.
  const saved = layoutOf(activeGroupId).activeBySlot[slot];
  const activeId = tabs.some((t) => t.id === saved) ? saved : (tabs[0]?.id ?? null);

  return { groupId: activeGroupId, slot, activeId, tabs };
}

/** Focus pane N of the active group — the bar's saved tab, or its first. */
function focusSlot(slot: number) {
  const { activeGroupId, layoutOf } = useProjects.getState();
  if (!activeGroupId) return;
  const tabs = tabsInSlot(activeGroupId, slot);
  if (tabs.length === 0) return;
  const saved = layoutOf(activeGroupId).activeBySlot[slot];
  const target = tabs.find((t) => t.id === saved) ?? tabs[0];
  activateTab(activeGroupId, slot, target);
}

function activateTab(groupId: string, slot: number, tab: TabRef) {
  if (tab.kind === "doc") {
    // The store also moves the pane's bar and drops the terminal focus.
    useEditor.getState().setActive(tab.id);
    return;
  }
  useProjects.getState().setActiveTab(groupId, slot, tab.id);
  // A page or the notebook in focus is no terminal in focus — same rule as
  // clicking the tab.
  useUI
    .getState()
    .focusTerminal(tab.kind === "term" ? tab.id : null, slot);
}
