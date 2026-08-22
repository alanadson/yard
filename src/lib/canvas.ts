/**
 * Data model and geometry of canvas mode (§F2-canvas).
 *
 * Everything here is independent of rendering: the types travel inside the
 * group's `layoutJson` (persisted with the workspace) and the geometry
 * serves both painting and hit-testing clicks. Drawing libraries
 * (roughjs / perfect-freehand) live in `CanvasView/render.ts` so this
 * file can be imported by the store at no cost.
 *
 * Coordinates: "world" is px at zoom 1. The screen shows
 * `screen = (world - viewport.xy) * viewport.zoom`.
 */

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

/** Rectangle of a terminal on the canvas, in world coordinates. */
export interface CanvasNode {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Card customization color (tints the header). Absent = default. */
  color?: string;
  /**
   * Terminal body font size, in px, for this card only. Absent = whatever the
   * global preference says.
   *
   * It lives per card because a canvas is not a grid: one terminal is blown up
   * to be read across the room while three others sit small in a corner, and
   * the size that suits one ruins the others. Changing it reflows the PTY
   * (fewer columns, bigger glyphs) — which is the point, since the alternative
   * is a 200-column wall of unreadable text.
   */
  fontSize?: number;
}

export type StrokeSize = "s" | "m" | "l";

/** Thickness in world px of each stroke size. */
export const STROKE_PX: Record<StrokeSize, number> = { s: 2, m: 3.5, l: 6 };

interface ItemBase {
  id: string;
  color: string;
}

export type CanvasItem =
  | (ItemBase & { type: "stroke"; points: number[]; size: StrokeSize })
  | (ItemBase & {
      type: "rect" | "ellipse";
      x: number;
      y: number;
      w: number;
      h: number;
      size: StrokeSize;
      seed: number;
    })
  | (ItemBase & {
      type: "line" | "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      size: StrokeSize;
      seed: number;
    })
  | (ItemBase & { type: "text"; x: number; y: number; text: string; fontSize: number })
  | (ItemBase & {
      type: "note";
      x: number;
      y: number;
      w: number;
      h: number;
      text: string;
      /** Pinned name (`--name` on the CLI). Without it, the name comes from the 1st line. */
      name?: string;
      /**
       * Tint of the note body. `color` paints only the grab strip at the top;
       * this one colors the note itself, which is how a wall of notes gets
       * sorted by eye. Absent means the default surface — the common case, and
       * the reason it is optional rather than defaulted to `color`.
       */
      fill?: string;
      /**
       * Locked note: only the user edits. The CLI refuses `note write/edit/delete`
       * — that is how you keep a briefing safe from an enthusiastic agent.
       */
      locked?: boolean;
      /**
       * Body font size in px, for this note only. Absent = the default size.
       *
       * Same reason the cards carry one: on a canvas a note is read from
       * wherever the camera happens to be. A heading pinned over a group of
       * terminals has to be legible zoomed out; the checklist beside it does
       * not, and blowing both up wastes the board.
       */
      fontSize?: number;
    })
  | (ItemBase & {
      type: "portal";
      x: number;
      y: number;
      w: number;
      h: number;
      url: string;
      /** Pinned name (`--name` on the CLI). Without it, the name is the hostname. */
      name?: string;
      /**
       * Engine id from `list_browsers` (`webview2`, `chrome`, `firefox`…).
       * Missing = native WebView2. A saved engine that is no longer installed
       * falls back to the native one at open time.
       */
      engine?: string;
      /** UA preset id (`ios`, `android`, `chrome`…) or a full override string. */
      ua?: string;
      muted?: boolean;
      /** Cookie/profile scope. Missing = instance (this card only). */
      storage?: PortalStorage;
      /** CSS viewport the site should see. Missing = the card body size. */
      viewport?: { w: number; h: number };
      /**
       * Auto-reload when the site changes (`lib/portalLive.ts`). Missing = on
       * for a local address, off for the internet — a portal on a dev server
       * is there to be watched, one on a site is there to be read.
       */
      live?: boolean;
    })
  | (ItemBase & {
      type: "flow";
      x: number;
      y: number;
      w: number;
      h: number;
      /** What the card and `yard flow` call it. */
      name: string;
      /** The esteira: prompts executed in order by whichever CLI is wired in. */
      stages: FlowStage[];
      /**
       * Wired CLIs are triggers: on connect/save they are handed a standing
       * instruction to forward any user task to `yard flow run`. `false`
       * keeps the flow manual (HUD or an agent calling it on its own).
       */
      trigger?: boolean;
    })
  | (ItemBase & { type: "connection"; from: string; to: string });

export type PortalStorage = "instance" | "workspace" | "global";

export type CanvasItemType = CanvasItem["type"];

/**
 * Scheduled prompt for a terminal ("every N minutes, run X").
 *
 * The firing lives in `hooks/useRoutines.ts` and only happens with the
 * terminal alive and **idle**: interrupting an agent mid-work would be worse
 * than having no routine at all.
 */
/**
 * Bounds of a routine's interval, in minutes.
 *
 * The floor is what keeps a routine from becoming a flood; the ceiling is what
 * keeps it from becoming a lie. `everyMin` had no upper bound, so a typo
 * (`--every 999999`) produced a routine that reads as scheduled, is listed as
 * active and never fires — indistinguishable from a paused one except by
 * arithmetic.
 */
export const ROUTINE_MIN_MIN = 1;
/** A week. Past that a "routine" is a reminder for another tool. */
export const ROUTINE_MAX_MIN = 7 * 24 * 60;

/** Clamps an interval the user (or an agent) typed into the allowed range. */
export function clampRoutineInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return 30;
  return Math.min(ROUTINE_MAX_MIN, Math.max(ROUTINE_MIN_MIN, Math.round(minutes)));
}

export interface RoutineDef {
  id: string;
  terminalId: string;
  text: string;
  /** Interval in minutes. With `once`, it is the delay until the single fire. */
  everyMin: number;
  enabled: boolean;
  /** Reminder: fires once and turns itself off. */
  once?: boolean;
  createdAt: number;
  lastRunAt?: number;
}

/**
 * One stage of a flow: a titled prompt. No terminal here on purpose — a flow
 * is a reusable pipeline of prompts, and the CLI that runs it is whichever one
 * the user *wired to the flow card* on the canvas.
 */
export interface FlowStage {
  /**
   * The instructions injected on this stage's turn, around the task ("Revise
   * como QA...", "Escreva os testes..."). The stage's whole substance.
   */
  prompt: string;
  /** What the user called this stage ("QA", "TDD"…). Optional. */
  label?: string;
}

/** Longest flow name that still reads on the card's header. */
export const FLOW_NAME_MAX = 48;

/** Stages the persisted JSON is allowed to keep — junk entries dropped. */
export function normalizeFlowStages(raw: unknown): FlowStage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is FlowStage => !!s && typeof s === "object")
    .map((s) => ({
      prompt: typeof s.prompt === "string" ? s.prompt : "",
      ...(typeof s.label === "string" && s.label.trim()
        ? { label: s.label.trim() }
        : {}),
    }));
}

/**
 * The role a card carries: the short name that fits on the chip, and the
 * instructions the CLI was actually given.
 *
 * It used to be one string doing both jobs, which was fine while a role was a
 * word ("revisora") and nothing but a label. Now that the text is handed to
 * the process on start, a role is a paragraph — and a paragraph on the chip is
 * unreadable. So the two split, and `normalizeRole` still accepts the old
 * single string (every board saved before this, and `yard role set` with free
 * text) by treating it as a role whose name is all there is to it.
 */
export interface CardRole {
  name: string;
  /** What the CLI is told. Absent = the name is the whole role. */
  text?: string;
}

/** A reusable role, saved under its name (in a group or globally). */
export interface RolePreset {
  text: string;
  /** Tints the card of whoever is born with this role. */
  color?: string;
}

export interface CanvasData {
  viewport: CanvasViewport;
  /** terminalId -> rectangle. A terminal with no entry gets an automatic position. */
  nodes: Record<string, CanvasNode>;
  items: CanvasItem[];
  /** terminalId -> assigned role. Dropped when empty. */
  roles?: Record<string, CardRole>;
  /** Scheduled prompts of this group. Dropped when empty. */
  routines?: RoutineDef[];
  /** Reusable roles scoped to this group (`--scope current`). */
  rolePresets?: Record<string, RolePreset>;
}

/** Longest role name that still reads as a label on the card's chip. */
export const ROLE_NAME_MAX = 40;

/**
 * A role out of free text: the first line names it, the whole text instructs.
 *
 * A one-line role keeps `text` empty on purpose — that is the legacy shape,
 * and a label like "revisora" is not an instruction anybody wants pasted into
 * a terminal on start.
 */
export function roleFromText(raw: string): CardRole | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const first = text.split("\n")[0].trim();
  if (text === first && first.length <= ROLE_NAME_MAX) return { name: first };
  const name =
    first.length <= ROLE_NAME_MAX ? first : `${first.slice(0, ROLE_NAME_MAX - 1)}…`;
  return { name, text };
}

/** Accepts both the old string form and the current object. */
export function normalizeRole(raw: unknown): CardRole | undefined {
  if (typeof raw === "string") return roleFromText(raw);
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<CardRole>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const text = typeof r.text === "string" ? r.text.trim() : "";
  if (!name) return roleFromText(text);
  return text && text !== name ? { name, text } : { name };
}

export function normalizeRoles(raw: unknown): Record<string, CardRole> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const roles: Record<string, CardRole> = {};
  for (const [id, value] of Object.entries(raw)) {
    const role = normalizeRole(value);
    if (role) roles[id] = role;
  }
  return Object.keys(roles).length ? roles : undefined;
}

/** Same tolerance for the preset library: `"texto"` or `{ text, color }`. */
export function normalizePresets(
  raw: unknown,
): Record<string, RolePreset> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const presets: Record<string, RolePreset> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!name.trim()) continue;
    const source =
      typeof value === "string"
        ? { text: value }
        : value && typeof value === "object"
          ? (value as Partial<RolePreset>)
          : null;
    const text = typeof source?.text === "string" ? source.text.trim() : "";
    if (!text) continue;
    const color = typeof source?.color === "string" ? source.color.trim() : "";
    presets[name.trim()] = color ? { text, color } : { text };
  }
  return Object.keys(presets).length ? presets : undefined;
}

/**
 * Window event fired when someone who is **not** the user changes the
 * canvas (the `yard` CLI, a routine). `CanvasView` uses this to drop the
 * undo stack: the user's `Ctrl+Z` must never undo what an agent wrote
 * in a note.
 */
export const CANVAS_EXTERNAL_WRITE = "yard:canvas-write";

export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 0.85 };

export const EMPTY_CANVAS: CanvasData = {
  viewport: { ...DEFAULT_VIEWPORT },
  nodes: {},
  items: [],
};

/** Display/addressing name of a note: the pinned one or the 1st line. */
export function noteName(it: Extract<CanvasItem, { type: "note" }>): string {
  if (it.name && it.name.trim()) return it.name.trim();
  const first = it.text.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "";
  return (first || "nota sem título").slice(0, 48);
}

/** Display/addressing name of a portal: the pinned one or the URL hostname. */
export function portalName(it: Extract<CanvasItem, { type: "portal" }>): string {
  if (it.name && it.name.trim()) return it.name.trim();
  return hostnameOf(it.url);
}

/**
 * Hostname used as the default portal name. Never throws on junk URLs.
 *
 * Implemented here because `portalName` above needs it, but `lib/portals.ts`
 * is the door everything else imports it through — that module is where a
 * reader looks for portal rules.
 */
export function hostnameOf(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "Portal";
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
    const host = new URL(withScheme).hostname.replace(/^www\./, "");
    return (host || "Portal").slice(0, 48);
  } catch {
    return raw.replace(/^https?:\/\//, "").split("/")[0]?.slice(0, 48) || "Portal";
  }
}

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;

/** Canvas palette: neutrals first, chroma only when the drawing asks for it.
    The chroma steps are vivid system hues tuned for the dark ground. */
export const CANVAS_COLORS = [
  "#f5f5f5",
  "#a3a3a3",
  "#6b6b6b",
  "#ff6961",
  "#40d16e",
  "#f0c33c",
  "#5fa8ff",
  "#c98bf2",
] as const;

/**
 * Which ink a note filled with `fill` needs.
 *
 * The fill is painted flat — diluting a hue into the dark surface gives mud
 * (the yellow came out olive) — so the block ends up anywhere from `#f5f5f5`
 * to `#6b6b6b` and no single hardcoded text color survives both ends. This is
 * the W3C crossover: above it black beats white on that background, below it
 * the reverse.
 */
export function noteInk(fill: string): "dark" | "light" {
  const hex = fill.trim().replace("#", "");
  const bytes =
    hex.length === 3
      ? [...hex].map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (bytes.length !== 3 || bytes.some((v) => !Number.isFinite(v))) return "light";
  const [r, g, b] = bytes.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.1791 ? "dark" : "light";
}

export const NODE_MIN_W = 260;
export const NODE_MIN_H = 160;

/**
 * Bounds of a card's own font size. The floor is where a glyph stops being a
 * glyph; the ceiling is where a 900px card would hold fewer than 40 columns
 * and most CLIs start wrapping into nonsense.
 */
export const NODE_FONT_MIN = 6;
export const NODE_FONT_MAX = 36;
export const NODE_FONT_STEP = 1;
export const NODE_DEFAULT_W = 640;
export const NODE_DEFAULT_H = 400;

export const PORTAL_MIN_W = 320;
export const PORTAL_MIN_H = 220;
export const PORTAL_DEFAULT_W = 720;
export const PORTAL_DEFAULT_H = 480;

export const NOTE_MIN_W = 140;
export const NOTE_MIN_H = 90;

export const FLOW_MIN_W = 220;
export const FLOW_DEFAULT_W = 270;
export const FLOW_MIN_H = 110;

/**
 * Height a flow card wants for `n` stages: header + one row per stage +
 * footer hint. The editor writes it on save, so the card on the board always
 * shows the whole pipeline without a scrollbar.
 */
export function flowCardHeight(n: number): number {
  return clamp(66 + Math.max(1, n) * 30, FLOW_MIN_H, 340);
}

/**
 * Bounds of a note's body font. The floor is `--fs-xs` minus a notch (a note
 * deliberately set to whisper); the ceiling is where a note stops being a note
 * and should have been a text item.
 */
export const NOTE_FONT_MIN = 9;
export const NOTE_FONT_MAX = 48;
/** What a note paints with when it carries no size of its own (`--fs-sm`). */
export const NOTE_FONT_DEFAULT = 12;

/**
 * Bounds of a canvas text. It goes much higher than a note's because a text
 * item *is* the label of a region — the sign you read across the board at 20%
 * zoom — and much lower because the same tool writes the footnote under it.
 */
export const TEXT_FONT_MIN = 8;
export const TEXT_FONT_MAX = 200;
/** Size of a text created with no explicit choice (the "médio" preset). */
export const TEXT_FONT_DEFAULT = 22;

/**
 * The font size one notch up (`dir` 1) or down (-1).
 *
 * The step is proportional, not a fixed pixel: +1px is a jump at 9px and
 * invisible at 120px, and these items span that whole range. The `Math.max`
 * keeps the small end moving — 12% of 9px rounds to 1, and without the floor a
 * rounding of 0 would freeze the stepper.
 */
export function stepFont(px: number, dir: -1 | 1, min: number, max: number): number {
  return clamp(px + dir * Math.max(1, Math.round(px * 0.12)), min, max);
}

/**
 * Stage of a live box gesture (drag or resize) on the canvas.
 *
 * `live` is the per-frame preview, which touches no persisted state;
 * `commit` writes the final rectangle and opens an undo entry; `cancel` is a
 * gesture that ended where it started and must leave no trace — a click on a
 * card header is not a move, and should not cost a workspace write.
 */
export type RectPhase = "live" | "commit" | "cancel";

/** The eight resize directions, plus `move` for dragging the whole box. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_DIRS: readonly ResizeDir[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

/** The corners alone — what a uniform scale (a text item) can honestly offer. */
export const CORNER_DIRS: readonly ResizeDir[] = ["ne", "nw", "se", "sw"];

/**
 * The rectangle after dragging `dir` by (dx, dy) in *world* units.
 *
 * The opposite edge is what stays still — that's the whole point of pulling
 * the north or west side, and it's why the minimum can't be a plain
 * `Math.max` on the size: clamping w without moving x back would let the box
 * keep sliding after it stopped shrinking.
 */
export function resizeRect(
  start: Box,
  dir: ResizeDir,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): Box {
  const r = { ...start };
  if (dir.includes("e")) r.w = Math.max(minW, start.w + dx);
  if (dir.includes("w")) {
    r.w = Math.max(minW, start.w - dx);
    r.x = start.x + (start.w - r.w);
  }
  if (dir.includes("s")) r.h = Math.max(minH, start.h + dy);
  if (dir.includes("n")) {
    r.h = Math.max(minH, start.h - dy);
    r.y = start.y + (start.h - r.h);
  }
  return r;
}

/**
 * Validates what came from the persisted JSON. Trusts nothing: a crooked
 * field here must not take down the entire workspace on boot.
 */
export function normalizeCanvas(raw: unknown): CanvasData | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<CanvasData>;
  const vp = r.viewport;
  const viewport: CanvasViewport =
    vp &&
    typeof vp.x === "number" &&
    typeof vp.y === "number" &&
    typeof vp.zoom === "number" &&
    Number.isFinite(vp.x) &&
    Number.isFinite(vp.y) &&
    Number.isFinite(vp.zoom)
      ? { x: vp.x, y: vp.y, zoom: clamp(vp.zoom, ZOOM_MIN, ZOOM_MAX) }
      : { ...DEFAULT_VIEWPORT };

  const nodes: Record<string, CanvasNode> = {};
  if (r.nodes && typeof r.nodes === "object") {
    for (const [id, n] of Object.entries(r.nodes)) {
      if (
        n &&
        [n.x, n.y, n.w, n.h].every((v) => typeof v === "number" && Number.isFinite(v))
      ) {
        nodes[id] = {
          x: n.x,
          y: n.y,
          w: Math.max(NODE_MIN_W, n.w),
          h: Math.max(NODE_MIN_H, n.h),
          ...(typeof n.color === "string" && n.color ? { color: n.color } : {}),
          ...(typeof n.fontSize === "number" && Number.isFinite(n.fontSize)
            ? { fontSize: clamp(Math.round(n.fontSize), NODE_FONT_MIN, NODE_FONT_MAX) }
            : {}),
        };
      }
    }
  }

  const items = Array.isArray(r.items)
    ? (r.items as CanvasItem[]).filter(isValidItem).map(sanitizeItem)
    : [];

  const data: CanvasData = { viewport, nodes, items };
  const roles = normalizeRoles(r.roles);
  if (roles) data.roles = roles;
  if (Array.isArray(r.routines)) {
    const routines = (r.routines as RoutineDef[]).filter(isValidRoutine);
    if (routines.length) data.routines = routines;
  }
  const presets = normalizePresets(r.rolePresets);
  if (presets) data.rolePresets = presets;
  return data;
}

/** Drops junk on optional fields so a crooked save cannot poison the type. */
function sanitizeItem(it: CanvasItem): CanvasItem {
  if (it.type === "text") {
    // Required field, so a crooked one cannot be dropped — it falls back.
    // `textBox` divides by it, and a NaN here would take hit-testing and the
    // whole selection outline down with it.
    const px = Number.isFinite(it.fontSize) ? it.fontSize : TEXT_FONT_DEFAULT;
    return {
      ...it,
      fontSize: clamp(Math.round(px), TEXT_FONT_MIN, TEXT_FONT_MAX),
    };
  }
  if (it.type === "note") {
    const px =
      typeof it.fontSize === "number" && Number.isFinite(it.fontSize)
        ? clamp(Math.round(it.fontSize), NOTE_FONT_MIN, NOTE_FONT_MAX)
        : undefined;
    return { ...it, fontSize: px };
  }
  if (it.type === "flow") {
    return {
      ...it,
      w: Math.max(FLOW_MIN_W, it.w),
      h: Math.max(FLOW_MIN_H, it.h),
      name: (it.name || "Fluxo").trim().slice(0, FLOW_NAME_MAX) || "Fluxo",
      stages: normalizeFlowStages(it.stages),
      ...(it.trigger === false ? { trigger: false } : { trigger: undefined }),
    };
  }
  if (it.type !== "portal") return it;
  const storage =
    it.storage === "workspace" || it.storage === "global" || it.storage === "instance"
      ? it.storage
      : undefined;
  const viewport =
    it.viewport &&
    Number.isFinite(it.viewport.w) &&
    Number.isFinite(it.viewport.h) &&
    it.viewport.w > 0 &&
    it.viewport.h > 0
      ? { w: Math.round(it.viewport.w), h: Math.round(it.viewport.h) }
      : undefined;
  return {
    ...it,
    w: Math.max(PORTAL_MIN_W, it.w),
    h: Math.max(PORTAL_MIN_H, it.h),
    url: it.url.trim(),
    ...(typeof it.name === "string" && it.name.trim() ? { name: it.name.trim() } : { name: undefined }),
    ...(typeof it.engine === "string" && it.engine.trim()
      ? { engine: it.engine.trim() }
      : { engine: undefined }),
    ...(typeof it.ua === "string" && it.ua.trim() ? { ua: it.ua.trim() } : { ua: undefined }),
    ...(it.muted ? { muted: true } : { muted: undefined }),
    ...(storage ? { storage } : { storage: undefined }),
    ...(viewport ? { viewport } : { viewport: undefined }),
    ...(typeof it.live === "boolean" ? { live: it.live } : { live: undefined }),
  };
}

function isValidRoutine(r: RoutineDef): boolean {
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.terminalId === "string" &&
    typeof r.text === "string" &&
    Number.isFinite(r.everyMin) &&
    r.everyMin > 0 &&
    typeof r.enabled === "boolean" &&
    Number.isFinite(r.createdAt)
  );
}

/** Is the routine due? `agora` is passed in so the test can be deterministic. */
/**
 * When this routine fires again. The list only showed "last run", so the most
 * obvious question — "and the next?" — had no answer anywhere in the
 * interface.
 */
export function routineNextAt(r: RoutineDef): number {
  return (r.lastRunAt ?? r.createdAt) + r.everyMin * 60_000;
}

export function routineDue(r: RoutineDef, now: number): boolean {
  if (!r.enabled) return false;
  const since = r.lastRunAt ?? r.createdAt;
  return now - since >= r.everyMin * 60_000;
}

function isValidItem(it: CanvasItem): boolean {
  if (!it || typeof it !== "object" || typeof it.id !== "string") return false;
  switch (it.type) {
    case "stroke":
      return Array.isArray(it.points) && it.points.length >= 4;
    case "rect":
    case "ellipse":
      return [it.x, it.y, it.w, it.h].every(Number.isFinite);
    case "line":
    case "arrow":
      return [it.x1, it.y1, it.x2, it.y2].every(Number.isFinite);
    case "text":
      return Number.isFinite(it.x) && Number.isFinite(it.y) && typeof it.text === "string";
    case "note":
      return [it.x, it.y, it.w, it.h].every(Number.isFinite) && typeof it.text === "string";
    case "portal":
      return (
        [it.x, it.y, it.w, it.h].every(Number.isFinite) &&
        typeof it.url === "string" &&
        it.url.trim().length > 0
      );
    case "flow":
      return (
        [it.x, it.y, it.w, it.h].every(Number.isFinite) &&
        typeof it.name === "string" &&
        Array.isArray(it.stages)
      );
    case "connection":
      return typeof it.from === "string" && typeof it.to === "string";
    default:
      return false;
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Automatic position of a terminal with no saved rectangle: 3-column grid. */
export function autoNodeRect(index: number): CanvasNode {
  const col = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: 90 + col * (NODE_DEFAULT_W + 70),
    y: 70 + row * (NODE_DEFAULT_H + 90) + col * 24,
    w: NODE_DEFAULT_W,
    h: NODE_DEFAULT_H,
  };
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Evaluates the connection's cubic bezier at `t` (for sampled hit-testing). */
function cubicAt(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export interface ConnectionGeom {
  /** SVG path of the curve. */
  d: string;
  /** Control points, so the hit-test samples the same curve. */
  cubic: [number, number, number, number, number, number, number, number];
}

/**
 * Exponent of the exit-tangent axis blend. The higher it is, the sooner the
 * curve "sticks" to pure horizontal/vertical — 4 keeps the orthogonal look of
 * a professional flow and only opens the diagonal very near the exact corner.
 */
const AXIS_SNAP = 4;
/**
 * Min and max slack of the control points, in world units. The floor is
 * low on purpose: with two nodes almost touching, slack greater than half
 * the gap makes the two controls overshoot each other and the wire zigzags.
 */
const CTRL_MIN = 18;
const CTRL_MAX = 260;

interface Vec {
  x: number;
  y: number;
}

/**
 * Exit tangent of rectangle `r` toward (dx, dy): a **continuous** blend
 * between the horizontal and vertical axes.
 *
 * The weight comes from the delta normalized by the half-axes (a wide card
 * prefers to leave through the sides) raised to `AXIS_SNAP`. Picking the
 * axis with `if` — as before — makes the wire *jump* sides the instant
 * the drag crosses the diagonal; here the angle sweeps smoothly and nothing
 * ever jumps.
 */
function exitTangent(r: CanvasNode, dx: number, dy: number): Vec {
  const u = Math.abs(dx) / Math.max(r.w / 2, 1);
  const v = Math.abs(dy) / Math.max(r.h / 2, 1);
  const pu = Math.pow(u, AXIS_SNAP);
  const pv = Math.pow(v, AXIS_SNAP);
  const sum = pu + pv;
  // Concentric nodes: no preferred direction, exit to the right.
  if (!(sum > 0) || !Number.isFinite(sum)) return { x: dx < 0 ? -1 : 1, y: 0 };
  const wx = pu / sum;
  const x = Math.sign(dx) * wx;
  const y = Math.sign(dy) * (1 - wx);
  const len = Math.hypot(x, y);
  return len > 0 ? { x: x / len, y: y / len } : { x: 1, y: 0 };
}

/** Distance from the center to the rectangle border along unit direction `t`. */
function borderDistance(r: CanvasNode, t: Vec): number {
  const hw = Math.max(r.w, 1) / 2;
  const hh = Math.max(r.h, 1) / 2;
  const tx = Math.abs(t.x) < 1e-6 ? Infinity : hw / Math.abs(t.x);
  const ty = Math.abs(t.y) < 1e-6 ? Infinity : hh / Math.abs(t.y);
  return Math.min(tx, ty);
}

/**
 * Control-point slack from how far "ahead" of the tangent the other node
 * sits. Distant target => wide curve; target behind or overlapping => slack
 * grows with the square root, avoiding the ugly loop when nodes touch.
 * Continuous at `gap = 0` (both branches equal `CTRL_MIN` there).
 */
function controlOffset(gap: number): number {
  if (gap >= 0) return clamp(gap * 0.5, CTRL_MIN, CTRL_MAX);
  return clamp(CTRL_MIN + Math.sqrt(-gap) * 6, CTRL_MIN, CTRL_MAX);
}

/**
 * Curve between two rectangles. Exit and arrival are orthogonal when the
 * nodes face each other (the React Flow look) and rotate continuously as
 * one of them crosses the diagonal — the whole geometry is a continuous
 * function of the two boxes, so dragging a card moves the wire with no jump.
 *
 * The wire has no head: it is a cable running from one card's border to the
 * other's, and the direction lives in the item (`from`/`to`), not in a tip.
 *
 * This is the wire **at rest**. The slack it picks up while a card is being
 * dragged is not geometry, it is motion — see `lib/wobble.ts`.
 */
export function connectionGeometry(a: CanvasNode, b: CanvasNode): ConnectionGeom {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;

  const ta = exitTangent(a, dx, dy);
  const tb = exitTangent(b, -dx, -dy);

  const ra = borderDistance(a, ta);
  const rb = borderDistance(b, tb);
  const sx = acx + ta.x * ra;
  const sy = acy + ta.y * ra;
  const ex = bcx + tb.x * rb;
  const ey = bcy + tb.y * rb;

  const ka = controlOffset((ex - sx) * ta.x + (ey - sy) * ta.y);
  const kb = controlOffset((sx - ex) * tb.x + (sy - ey) * tb.y);
  const c1x = sx + ta.x * ka;
  const c1y = sy + ta.y * ka;
  const c2x = ex + tb.x * kb;
  const c2y = ey + tb.y * kb;

  return {
    d: `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`,
    cubic: [sx, sy, c1x, c1y, c2x, c2y, ex, ey],
  };
}

/** Approximate text box (no DOM here; used for eraser/selection). */
export function textBox(it: Extract<CanvasItem, { type: "text" }>): Box {
  const lines = it.text.split("\n");
  const widest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  return {
    x: it.x,
    y: it.y,
    w: Math.max(24, widest * it.fontSize * 0.58),
    h: Math.max(it.fontSize * 1.4, lines.length * it.fontSize * 1.4),
  };
}

/** Bounding box of the item, for the selection outline. */
export function itemBounds(
  it: CanvasItem,
  nodeOf: (id: string) => CanvasNode | undefined,
): Box | null {
  switch (it.type) {
    case "stroke": {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < it.points.length; i += 2) {
        minX = Math.min(minX, it.points[i]);
        maxX = Math.max(maxX, it.points[i]);
        minY = Math.min(minY, it.points[i + 1]);
        maxY = Math.max(maxY, it.points[i + 1]);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case "rect":
    case "ellipse":
    case "note":
    case "portal":
    case "flow":
      return { x: it.x, y: it.y, w: it.w, h: it.h };
    case "line":
    case "arrow":
      return {
        x: Math.min(it.x1, it.x2),
        y: Math.min(it.y1, it.y2),
        w: Math.abs(it.x2 - it.x1),
        h: Math.abs(it.y2 - it.y1),
      };
    case "text":
      return textBox(it);
    case "connection": {
      const a = nodeOf(it.from);
      const b = nodeOf(it.to);
      if (!a || !b) return null;
      const g = connectionGeometry(a, b);
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = g.cubic;
      return {
        x: Math.min(sx, ex, c1x, c2x),
        y: Math.min(sy, ey, c1y, c2y),
        w: Math.abs(Math.max(sx, ex, c1x, c2x) - Math.min(sx, ex, c1x, c2x)),
        h: Math.abs(Math.max(sy, ey, c1y, c2y) - Math.min(sy, ey, c1y, c2y)),
      };
    }
  }
}

/**
 * Does the point (in world) hit the item? `tol` should already come divided
 * by zoom — the farther the camera, the larger the useful finger area.
 */
export function hitItem(
  it: CanvasItem,
  wx: number,
  wy: number,
  tol: number,
  nodeOf: (id: string) => CanvasNode | undefined,
): boolean {
  switch (it.type) {
    case "stroke": {
      const t = tol + STROKE_PX[it.size];
      for (let i = 0; i + 3 < it.points.length; i += 2) {
        if (
          distToSegment(
            wx,
            wy,
            it.points[i],
            it.points[i + 1],
            it.points[i + 2],
            it.points[i + 3],
          ) <= t
        )
          return true;
      }
      return false;
    }
    case "rect": {
      const t = tol + STROKE_PX[it.size];
      const { x, y, w, h } = it;
      return (
        distToSegment(wx, wy, x, y, x + w, y) <= t ||
        distToSegment(wx, wy, x + w, y, x + w, y + h) <= t ||
        distToSegment(wx, wy, x + w, y + h, x, y + h) <= t ||
        distToSegment(wx, wy, x, y + h, x, y) <= t
      );
    }
    case "ellipse": {
      const rx = Math.max(1, it.w / 2);
      const ry = Math.max(1, it.h / 2);
      const dx = (wx - (it.x + rx)) / rx;
      const dy = (wy - (it.y + ry)) / ry;
      const t = (tol + STROKE_PX[it.size]) / Math.min(rx, ry);
      return Math.abs(Math.hypot(dx, dy) - 1) <= t;
    }
    case "line":
    case "arrow":
      return (
        distToSegment(wx, wy, it.x1, it.y1, it.x2, it.y2) <= tol + STROKE_PX[it.size]
      );
    case "text": {
      const b = textBox(it);
      return wx >= b.x - tol && wx <= b.x + b.w + tol && wy >= b.y - tol && wy <= b.y + b.h + tol;
    }
    case "note":
    case "portal":
    case "flow":
      return (
        wx >= it.x - tol && wx <= it.x + it.w + tol && wy >= it.y - tol && wy <= it.y + it.h + tol
      );
    case "connection": {
      const a = nodeOf(it.from);
      const b = nodeOf(it.to);
      if (!a || !b) return false;
      const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = connectionGeometry(a, b).cubic;
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const px = cubicAt(t, sx, c1x, c2x, ex);
        const py = cubicAt(t, sy, c1y, c2y, ey);
        if (Math.hypot(wx - px, wy - py) <= tol + 4) return true;
      }
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// identity reconciliation
// ---------------------------------------------------------------------------

/**
 * The canvas persists as JSON inside `layoutJson`, so **every** commit
 * (a keystroke in a note, the end of a stroke) returns a brand-new object
 * graph — and every `memo` in the render tree would fail with it. These
 * functions return the *previous* object when the content did not change,
 * so typing in a note re-renders a note, not the whole canvas.
 */
export function sameItem(a: CanvasItem, b: CanvasItem): boolean {
  if (a === b) return true;
  if (a.type !== b.type || a.id !== b.id || a.color !== b.color) return false;
  switch (a.type) {
    case "stroke": {
      const o = b as typeof a;
      if (a.size !== o.size || a.points.length !== o.points.length) return false;
      for (let i = 0; i < a.points.length; i++) {
        if (a.points[i] !== o.points[i]) return false;
      }
      return true;
    }
    case "rect":
    case "ellipse": {
      const o = b as typeof a;
      return (
        a.x === o.x &&
        a.y === o.y &&
        a.w === o.w &&
        a.h === o.h &&
        a.size === o.size &&
        a.seed === o.seed
      );
    }
    case "line":
    case "arrow": {
      const o = b as typeof a;
      return (
        a.x1 === o.x1 &&
        a.y1 === o.y1 &&
        a.x2 === o.x2 &&
        a.y2 === o.y2 &&
        a.size === o.size &&
        a.seed === o.seed
      );
    }
    case "text": {
      const o = b as typeof a;
      return a.x === o.x && a.y === o.y && a.text === o.text && a.fontSize === o.fontSize;
    }
    case "note": {
      const o = b as typeof a;
      return (
        a.x === o.x &&
        a.y === o.y &&
        a.w === o.w &&
        a.h === o.h &&
        a.text === o.text &&
        a.name === o.name &&
        a.fill === o.fill &&
        a.locked === o.locked &&
        a.fontSize === o.fontSize
      );
    }
    case "portal": {
      const o = b as typeof a;
      return (
        a.x === o.x &&
        a.y === o.y &&
        a.w === o.w &&
        a.h === o.h &&
        a.url === o.url &&
        a.name === o.name &&
        a.engine === o.engine &&
        a.ua === o.ua &&
        a.muted === o.muted &&
        a.storage === o.storage &&
        a.viewport?.w === o.viewport?.w &&
        a.viewport?.h === o.viewport?.h
      );
    }
    case "flow": {
      const o = b as typeof a;
      return (
        a.x === o.x &&
        a.y === o.y &&
        a.w === o.w &&
        a.h === o.h &&
        a.name === o.name &&
        a.trigger === o.trigger &&
        a.stages.length === o.stages.length &&
        a.stages.every(
          (s, i) => s.prompt === o.stages[i].prompt && s.label === o.stages[i].label,
        )
      );
    }
    case "connection": {
      const o = b as typeof a;
      return a.from === o.from && a.to === o.to;
    }
  }
}

/**
 * Reuses references from `prev` for items of identical content.
 * If nothing changed (same items, same order), returns `prev` itself.
 */
export function reconcileItems(prev: CanvasItem[], next: CanvasItem[]): CanvasItem[] {
  const byId = new Map<string, CanvasItem>();
  for (const it of prev) byId.set(it.id, it);
  let reusedAll = prev.length === next.length;
  const out = next.map((it, i) => {
    const old = byId.get(it.id);
    if (old && sameItem(old, it)) {
      if (reusedAll && prev[i] !== old) reusedAll = false;
      return old;
    }
    reusedAll = false;
    return it;
  });
  return reusedAll ? prev : out;
}

/** Same for the terminal rectangles. */
export function reconcileNodes(
  prev: Record<string, CanvasNode>,
  next: Record<string, CanvasNode>,
): Record<string, CanvasNode> {
  const keys = Object.keys(next);
  let reusedAll = keys.length === Object.keys(prev).length;
  const out: Record<string, CanvasNode> = {};
  for (const k of keys) {
    const o = prev[k];
    const n = next[k];
    // Every field a card paints from has to be compared here: reusing the old
    // reference for a node whose font just changed would keep the memoized
    // card from ever re-rendering.
    if (
      o &&
      o.x === n.x &&
      o.y === n.y &&
      o.w === n.w &&
      o.h === n.h &&
      o.color === n.color &&
      o.fontSize === n.fontSize
    ) {
      out[k] = o;
    } else {
      out[k] = n;
      reusedAll = false;
    }
  }
  return reusedAll ? prev : out;
}

/** Item shifted by (dx, dy). Connections follow the nodes; they do not move. */
export function translateItem(it: CanvasItem, dx: number, dy: number): CanvasItem {
  switch (it.type) {
    case "stroke": {
      const points = it.points.slice();
      for (let i = 0; i < points.length; i += 2) {
        points[i] += dx;
        points[i + 1] += dy;
      }
      return { ...it, points };
    }
    case "rect":
    case "ellipse":
    case "note":
    case "portal":
    case "flow":
      return { ...it, x: it.x + dx, y: it.y + dy };
    case "line":
    case "arrow":
      return { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy };
    case "text":
      return { ...it, x: it.x + dx, y: it.y + dy };
    case "connection":
      return it;
  }
}
