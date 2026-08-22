/**
 * The "cut / copy / paste / select all" block, ready to go into any context
 * menu.
 *
 * It exists because Yard swallows WebView2's native menu (the terminal
 * depends on that: the host's "Paste" wrote straight into the PTY) — so every
 * surface that opens a menu of its own has to give those four actions back,
 * or opening a menu **takes away** what the user already had. Writing that
 * five times is how "Paste" gets lost in one of the five.
 *
 * Deciding which entries fit the target belongs to `systemMenu` (pure,
 * tested). What lives here is what needs the DOM: reading the target, saving
 * the selection before the menu steals focus, and restoring it when acting.
 */
import {
  ClipboardPaste,
  Copy,
  Link2,
  Scissors,
  Search,
  Settings,
  SquareDashedMousePointer,
  TerminalSquare,
} from "lucide-react";

import { copyText, readClipboardText } from "./clipboard";
import {
  systemMenuGroups,
  type MenuTarget,
  type SystemMenuAction,
  type SystemMenuId,
} from "./systemMenu";
import type { MenuEntry } from "../components/ContextMenu";
import { useBench } from "../stores/benchStore";
import { useProjects } from "../stores/projectsStore";
import { useSearch } from "../stores/searchStore";
import { useUI } from "../stores/uiStore";

/** `input` types where text gets typed — checkbox and range are not fields. */
const TEXT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "tel",
  "password",
  "email",
  "number",
]);

/** Surfaces that show text without letting it be edited — copying there makes sense. */
const READ_ONLY = "pre, code, .cm-editor, .md-preview, .diff, [data-text-surface]";

/** The editable field under the cursor, or `null` if the click landed on none. */
function fieldUnder(el: Element | null): HTMLElement | null {
  const target = el?.closest?.("input, textarea, [contenteditable]");
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLInputElement) {
    if (!TEXT_TYPES.has(target.type)) return null;
    return target.readOnly || target.disabled ? null : target;
  }
  if (target instanceof HTMLTextAreaElement) {
    return target.readOnly || target.disabled ? null : target;
  }
  return target.isContentEditable ? target : null;
}

/** What is selected — inside the field, when there is one. */
function selectionOf(theField: HTMLElement | null): string {
  if (theField instanceof HTMLInputElement || theField instanceof HTMLTextAreaElement) {
    const { selectionStart: a, selectionEnd: b } = theField;
    return a !== null && b !== null ? theField.value.slice(a, b) : "";
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * The click, frozen.
 *
 * Opening the menu takes focus away from the field (the popup is focusable,
 * so the arrow keys work) and, with it, the live selection. Cut and paste
 * need both back — hence saving the field, the snippet and the range here,
 * at the instant of the click.
 */
export interface TextTarget {
  info: MenuTarget;
  textField: HTMLElement | null;
  /** Range inside the `input`/`textarea`. */
  span: [number, number] | null;
  /** The same when the field is contenteditable (CodeMirror included). */
  domRange: Range | null;
  link: string | null;
}

/** Reads everything the menu will need from the DOM, before it opens. */
export function captureTextTarget(e: { target: EventTarget | null }): TextTarget {
  const target = e.target instanceof Element ? e.target : null;
  const field = fieldUnder(target);
  const anchor = target?.closest?.("a[href]");
  const link = anchor instanceof HTMLAnchorElement ? anchor.href : null;
  const range =
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? ([field.selectionStart ?? 0, field.selectionEnd ?? 0] as [number, number])
      : null;
  const sel = window.getSelection();
  const domRange =
    !range && sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  return {
    textField: field,
    span: range,
    domRange,
    link,
    info: {
      editable: field !== null,
      readOnly: field === null && !!target?.closest?.(READ_ONLY),
      selection: selectionOf(field),
      link,
      hasProject: useProjects.getState().activeProjectId !== null,
    },
  };
}

/** Gives focus and selection back to the field — without it, cut and paste fall into the void. */
function restore(t: TextTarget) {
  const field = t.textField;
  if (!field) return;
  field.focus();
  if (
    (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
    t.span
  ) {
    field.setSelectionRange(t.span[0], t.span[1]);
    return;
  }
  if (t.domRange) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(t.domRange);
  }
}

/**
 * Writes `texto` at the cursor position.
 *
 * `insertText` is the native path and the only one React sees as typing (it
 * fires a real `input`, so the controlled field's `onChange` runs). When the
 * host refuses, the prototype setter is what is left — writing to `.value`
 * directly is ignored by React, because of its value tracker.
 */
function insertText(field: HTMLElement, theText: string) {
  if (document.execCommand("insertText", false, theText)) return;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    return;
  }
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const next = field.value.slice(0, start) + theText + field.value.slice(end);
  setter?.call(field, next);
  field.setSelectionRange(start + theText.length, start + theText.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const LABELS: Record<SystemMenuId, string> = {
  cut: "Recortar",
  copy: "Copiar",
  paste: "Colar",
  "select-all": "Selecionar tudo",
  "copy-link": "Copiar endereço do link",
  "search-selection": "Buscar no projeto",
  palette: "Paleta de comandos",
  prefs: "Preferências",
};

const SHORTCUTS: Partial<Record<SystemMenuId, string>> = {
  cut: "Ctrl+X",
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  "select-all": "Ctrl+A",
  palette: "Ctrl+P",
  prefs: "Ctrl+,",
};

function iconFor(id: SystemMenuId) {
  switch (id) {
    case "cut":
      return <Scissors size={13} />;
    case "copy":
      return <Copy size={13} />;
    case "paste":
      return <ClipboardPaste size={13} />;
    case "select-all":
      return <SquareDashedMousePointer size={13} />;
    case "copy-link":
      return <Link2 size={13} />;
    case "search-selection":
      return <Search size={13} />;
    case "palette":
      return <TerminalSquare size={13} />;
    case "prefs":
      return <Settings size={13} />;
  }
}

function runAction(t: TextTarget, action: SystemMenuAction) {
  const ui = useUI.getState();
  switch (action.id) {
    case "copy":
      void copyText(t.info.selection).then((ok) => {
        if (!ok) ui.showToast("Não consegui copiar.", "error");
      });
      return;
    case "copy-link":
      void copyText(t.link ?? "").then((ok) => {
        ui.showToast(
          ok ? "Endereço copiado." : "Não consegui copiar.",
          ok ? "info" : "error",
        );
      });
      return;
    case "cut":
      restore(t);
      // The native one does both halves at once and preserves the field's
      // undo; only when the host refuses is it reassembled by hand.
      if (!document.execCommand("cut")) {
        void copyText(t.info.selection).then((ok) => {
          if (ok) document.execCommand("delete");
          else ui.showToast("Não consegui recortar.", "error");
        });
      }
      return;
    case "paste":
      void readClipboardText().then((text) => {
        // Same contract as the terminal's "Paste": `null` is the host refusing
        // the read (native Ctrl+V still works and is what gets recommended),
        // `""` is a clipboard with no text. Different problems, different
        // advice.
        if (text === null) {
          ui.showToast("sem acesso à área de transferência — use Ctrl+V", "error");
          return;
        }
        if (!text) {
          ui.showToast("não há texto na área de transferência");
          return;
        }
        if (!t.textField) return;
        restore(t);
        insertText(t.textField, text);
      });
      return;
    case "select-all":
      restore(t);
      if (
        t.textField instanceof HTMLInputElement ||
        t.textField instanceof HTMLTextAreaElement
      ) {
        t.textField.select();
      } else {
        document.execCommand("selectAll");
      }
      return;
    case "search-selection":
      useSearch.getState().setQuery(t.info.selection.trim());
      useBench.getState().revealTab("search");
      return;
    case "palette":
      ui.openPalette();
      return;
    case "prefs":
      ui.openModal("preferences");
      return;
  }
}

/**
 * The target's text entries, with separators between the groups.
 *
 * `app: false` leaves out the "Palette / Preferences" footer — a surface that
 * already has its own menu ends with its own actions, not with the whole
 * application's.
 */
export function textMenuEntries(
  t: TextTarget,
  { app = true }: { app?: boolean } = {},
): MenuEntry[] {
  const groups = systemMenuGroups(t.info);
  const used = app ? groups : groups.slice(0, -1);
  const entries: MenuEntry[] = [];
  for (const group of used) {
    if (entries.length > 0) entries.push({ kind: "sep" });
    for (const action of group) {
      entries.push({
        id: action.id,
        label:
          action.id === "search-selection" && action.term
            ? `Buscar “${action.term}” no projeto`
            : LABELS[action.id],
        icon: iconFor(action.id),
        shortcut: SHORTCUTS[action.id],
        disabled: action.disabled,
        onSelect: () => runAction(t, action),
      });
    }
  }
  return entries;
}
