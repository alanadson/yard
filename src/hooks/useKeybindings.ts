/**
 * Global shortcuts. Rule: nothing here may steal a key the terminal needs.
 * That is why everything uses Ctrl+Shift or combinations the shell does not
 * consume (Ctrl+T and Ctrl+W have no use in ConPTY).
 *
 * The exceptions are Ctrl+Tab and Ctrl+1..9, which switch tabs: `XTermView`
 * hands those keys back to the window instead of sending them to the PTY.
 */
import { useEffect } from "react";

import { useChanges } from "../stores/changesStore";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";
import type { TerminalRow } from "../lib/ipc";

export function useKeybindings() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      // Ctrl+Enter — prompt composer. Inside the composer itself the
      // key already means "send", so the window does not intercept it there.
      if (!e.shiftKey && (e.code === "Enter" || e.code === "NumpadEnter")) {
        const alvo = e.target as HTMLElement | null;
        if (alvo?.closest?.(".composer")) return;
        e.preventDefault();
        useUI.getState().setComposerOpen(true);
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

      // Ctrl+B — toggle sidebar
      if (!e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        useUI.getState().toggleSidebar();
        return;
      }

      // Ctrl+Shift+D — files/changes panel
      if (e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        useChanges.getState().toggle();
        return;
      }

      // Ctrl+Shift+H — shortcut map
      if (e.shiftKey && e.code === "KeyH") {
        e.preventDefault();
        useUI.getState().openModal("shortcuts");
        return;
      }

      // Ctrl+Shift+F — find in the focused pane. Dispatched as a window
      // event so we do not wake a store selector on every mounted pane.
      if (e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("yard:find"));
        return;
      }

      // Ctrl+1..9 — go to tab N of the focused bar
      const digit = e.code.match(/^Digit([1-9])$/);
      if (digit && !e.shiftKey) {
        e.preventDefault();
        const ctx = focusedTabs();
        if (!ctx) return;
        const alvo = ctx.tabs[Number(digit[1]) - 1];
        if (alvo) activateTab(ctx.groupId, ctx.slot, alvo.id);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — next / previous tab
      if (e.code === "Tab") {
        e.preventDefault();
        const ctx = focusedTabs();
        if (!ctx || ctx.tabs.length < 2) return;
        const atual = ctx.tabs.findIndex((t) => t.id === ctx.activeId);
        const passo = e.shiftKey ? -1 : 1;
        const proximo =
          ctx.tabs[(atual + passo + ctx.tabs.length) % ctx.tabs.length];
        activateTab(ctx.groupId, ctx.slot, proximo.id);
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
  tabs: TerminalRow[];
} | null {
  const { activeGroupId, terminalsOf, layoutOf, terminal } =
    useProjects.getState();
  if (!activeGroupId) return null;
  const todos = terminalsOf(activeGroupId);
  if (todos.length === 0) return null;

  const { focusedTerminalId, focusedSlot } = useUI.getState();
  const focado = focusedTerminalId ? terminal(focusedTerminalId) : undefined;
  const preferido = focado?.groupId === activeGroupId ? focado.slot : focusedSlot;
  const slot = todos.some((t) => t.slot === preferido) ? preferido : todos[0].slot;
  const tabs = todos.filter((t) => t.slot === slot);

  // Same rule as `TerminalPane`: the saved tab only counts if it is still there.
  const salvo = layoutOf(activeGroupId).activeBySlot[slot];
  const activeId = tabs.some((t) => t.id === salvo) ? salvo : (tabs[0]?.id ?? null);

  return { groupId: activeGroupId, slot, activeId, tabs };
}

function activateTab(groupId: string, slot: number, terminalId: string) {
  useProjects.getState().setActiveTab(groupId, slot, terminalId);
  useUI.getState().focusTerminal(terminalId, slot);
}
