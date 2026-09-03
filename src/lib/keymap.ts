/**
 * The board's keys, as data.
 *
 * `V H P E R O L A T N W C F` were a literal inside the key handler, mirrored
 * in the toolbar's tooltips and in the shortcut table, and nobody could move
 * one without editing three files. Here the map is one table with defaults,
 * a user override per action (kept in the kv as `keys.canvas`), and the two
 * conversions Settings needs: a key event into a chord, a chord into the
 * label a person reads and types.
 *
 * Only the board's own keys live here. Copy, cut and paste keep the
 * browser's spelling; the arrows, Tab, Enter and Escape carry rules of their
 * own (see the key handler) and are not for rebinding.
 */

export type CanvasAction =
  | "tool.select"
  | "tool.pan"
  | "tool.pen"
  | "tool.eraser"
  | "tool.rect"
  | "tool.ellipse"
  | "tool.line"
  | "tool.arrow"
  | "tool.text"
  | "tool.note"
  | "tool.portal"
  | "tool.connect"
  | "tool.flow"
  | "undo"
  | "redo"
  | "zoomIn"
  | "zoomOut"
  | "zoom100"
  | "fit"
  | "fitSelection"
  | "minimap"
  | "tidy"
  | "group"
  | "duplicate"
  | "selectAll"
  | "rename"
  | "strokeThinner"
  | "strokeThicker";

export interface Chord {
  /** A `KeyboardEvent.code`: `KeyV`, `Digit1`, `F2`, `Equal`. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export const DEFAULT_KEYMAP: Readonly<Record<CanvasAction, Chord>> = {
  "tool.select": { key: "KeyV" },
  "tool.pan": { key: "KeyH" },
  "tool.pen": { key: "KeyP" },
  "tool.eraser": { key: "KeyE" },
  "tool.rect": { key: "KeyR" },
  "tool.ellipse": { key: "KeyO" },
  "tool.line": { key: "KeyL" },
  "tool.arrow": { key: "KeyA" },
  "tool.text": { key: "KeyT" },
  "tool.note": { key: "KeyN" },
  "tool.portal": { key: "KeyW" },
  "tool.connect": { key: "KeyC" },
  "tool.flow": { key: "KeyF" },
  undo: { key: "KeyZ", ctrl: true },
  redo: { key: "KeyZ", ctrl: true, shift: true },
  zoomIn: { key: "Equal", ctrl: true },
  zoomOut: { key: "Minus", ctrl: true },
  zoom100: { key: "Digit0", ctrl: true },
  fit: { key: "Digit1", shift: true },
  fitSelection: { key: "Digit2", shift: true },
  minimap: { key: "KeyM", ctrl: true, shift: true },
  tidy: { key: "KeyT", ctrl: true, shift: true },
  group: { key: "KeyG", ctrl: true },
  duplicate: { key: "KeyD", ctrl: true },
  selectAll: { key: "KeyA", ctrl: true },
  rename: { key: "F2" },
  strokeThinner: { key: "BracketLeft" },
  strokeThicker: { key: "BracketRight" },
};

export const CANVAS_ACTIONS = Object.keys(DEFAULT_KEYMAP) as CanvasAction[];

/** What Settings prints for each action. Portuguese, translated where drawn. */
// i18n-scan: tables
export const ACTION_LABELS: Readonly<Record<CanvasAction, string>> = {
  "tool.select": "Ferramenta: selecionar",
  "tool.pan": "Ferramenta: mover a tela",
  "tool.pen": "Ferramenta: caneta",
  "tool.eraser": "Ferramenta: borracha",
  "tool.rect": "Ferramenta: retângulo",
  "tool.ellipse": "Ferramenta: elipse",
  "tool.line": "Ferramenta: linha",
  "tool.arrow": "Ferramenta: seta",
  "tool.text": "Ferramenta: texto",
  "tool.note": "Ferramenta: nota",
  "tool.portal": "Ferramenta: portal",
  "tool.connect": "Ferramenta: conectar",
  "tool.flow": "Ferramenta: fluxo",
  undo: "Desfazer",
  redo: "Refazer",
  zoomIn: "Aproximar",
  zoomOut: "Afastar",
  zoom100: "Zoom 100%",
  fit: "Enquadrar tudo",
  fitSelection: "Enquadrar a seleção",
  minimap: "Mostrar ou esconder o minimapa",
  tidy: "Organizar em grade",
  group: "Agrupar a seleção",
  duplicate: "Duplicar a seleção",
  selectAll: "Selecionar tudo",
  rename: "Renomear o cartão selecionado",
  strokeThinner: "Traço mais fino",
  strokeThicker: "Traço mais grosso",
};

/** Overrides: an action to its chord, or `null` for "switched off". */
export type KeymapOverrides = Partial<Record<CanvasAction, Chord | null>>;

export type Keymap = Record<CanvasAction, Chord | null>;

interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The chord a key event spells. Meta is Ctrl: a Mac keyboard on Windows. */
export function chordFromEvent(e: KeyLike): Chord {
  const c: Chord = { key: e.code };
  if (e.ctrlKey || e.metaKey) c.ctrl = true;
  if (e.shiftKey) c.shift = true;
  if (e.altKey) c.alt = true;
  return c;
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && !!a.ctrl === !!b.ctrl && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

/** `code` to the name a person reads, for the keys the board binds. */
const KEY_NAMES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Delete: "Delete",
  Backspace: "Backspace",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const NAME_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(KEY_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEY_NAMES[code] ?? null;
}

function codeOf(name: string): string | null {
  const n = name.trim();
  if (/^[a-zA-Z]$/.test(n)) return `Key${n.toUpperCase()}`;
  if (/^\d$/.test(n)) return `Digit${n}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(n)) return `F${n.slice(1)}`;
  return NAME_KEYS[n.toLowerCase()] ?? null;
}

/** `Ctrl+Shift+T`, the spelling the shortcut table already uses. */
export function chordLabel(c: Chord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(keyName(c.key) ?? c.key);
  return parts.join("+");
}

/** The reverse, for a label typed into Settings. `null` when it names no key. */
export function parseChordLabel(label: string): Chord | null {
  const parts = label
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const c: Chord = { key: "" };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === "ctrl" || low === "control" || low === "cmd" || low === "meta") c.ctrl = true;
    else if (low === "shift") c.shift = true;
    else if (low === "alt" || low === "option") c.alt = true;
    else {
      if (c.key) return null;
      const code = codeOf(p);
      if (!code) return null;
      c.key = code;
    }
  }
  return c.key ? c : null;
}

function isChord(raw: unknown): raw is Chord {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Partial<Chord>;
  return typeof c.key === "string" && c.key.length > 0;
}

/** The overrides the kv holds, key by key; junk is dropped, never guessed at. */
export function normalizeKeymap(raw: unknown): KeymapOverrides {
  if (!raw || typeof raw !== "object") return {};
  const out: KeymapOverrides = {};
  for (const [action, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(action in DEFAULT_KEYMAP)) continue;
    if (value === null) out[action as CanvasAction] = null;
    else if (isChord(value)) {
      const c: Chord = { key: value.key };
      if (value.ctrl) c.ctrl = true;
      if (value.shift) c.shift = true;
      if (value.alt) c.alt = true;
      out[action as CanvasAction] = c;
    }
  }
  return out;
}

/** Defaults with the overrides laid over them. */
export function resolveKeymap(overrides: KeymapOverrides): Keymap {
  const out = {} as Keymap;
  for (const action of CANVAS_ACTIONS) {
    out[action] = action in overrides ? (overrides[action] ?? null) : DEFAULT_KEYMAP[action];
  }
  return out;
}

/** The action a key event means, or `null`. First in table order wins a tie. */
export function actionFor(map: Keymap, e: KeyLike): CanvasAction | null {
  const chord = chordFromEvent(e);
  for (const action of CANVAS_ACTIONS) {
    const bound = map[action];
    if (bound && sameChord(bound, chord)) return action;
  }
  return null;
}

/** Pairs of actions sharing one chord, in table order. */
export function conflicts(map: Keymap): [CanvasAction, CanvasAction][] {
  const out: [CanvasAction, CanvasAction][] = [];
  for (let i = 0; i < CANVAS_ACTIONS.length; i++) {
    const a = map[CANVAS_ACTIONS[i]];
    if (!a) continue;
    for (let j = i + 1; j < CANVAS_ACTIONS.length; j++) {
      const b = map[CANVAS_ACTIONS[j]];
      if (b && sameChord(a, b)) out.push([CANVAS_ACTIONS[i], CANVAS_ACTIONS[j]]);
    }
  }
  return out;
}
