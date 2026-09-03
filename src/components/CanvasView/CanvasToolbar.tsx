/**
 * Canvas tools, one button per *family* instead of one per tool.
 *
 * Twelve tools plus eight colors plus three thicknesses stacked into a rail
 * that ran the height of the window — a wall of icons where nothing stood out.
 * Grouping collapses this: the rail shows the tool you are holding in each
 * family, and clicking it both picks that tool and opens the family beside it.
 * The keyboard shortcuts are unchanged, so the fast path never grew a click;
 * only the browsing path did, and that one was drowning.
 */
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Spline,
  Square,
  Globe,
  StickyNote,
  Type,
  Undo2,
  Workflow,
} from "lucide-react";

import { CANVAS_COLORS, type StrokeSize } from "../../lib/canvas";
import { useOccluder } from "../../hooks/useOccluder";
import { useT } from "../../hooks/useT";

export type Tool =
  | "select"
  | "pan"
  | "pen"
  | "eraser"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "note"
  | "portal"
  | "connect"
  | "flow";

interface ToolDef {
  id: Tool;
  icon: React.ReactNode;
  label: string;
  key: string;
  /** Second line of the tooltip — what the tool means, not what it is. */
  hint?: string;
}

interface Family {
  id: string;
  label: string;
  tools: ToolDef[];
}

// i18n-scan: tables — every label and hint below is wrapped with t() where it is rendered.
/** Families in the order the hand reaches for them: point, draw, shape, place. */
const FAMILIES: Family[] = [
  {
    id: "point",
    label: "Ponteiro",
    tools: [
      { id: "select", icon: <MousePointer2 size={14} />, label: "Selecionar", key: "V" },
      { id: "pan", icon: <Hand size={14} />, label: "Mover a tela", key: "H" },
    ],
  },
  {
    id: "draw",
    label: "Desenho",
    tools: [
      { id: "pen", icon: <Pencil size={14} />, label: "Caneta", key: "P" },
      { id: "eraser", icon: <Eraser size={14} />, label: "Borracha", key: "E" },
    ],
  },
  {
    id: "shape",
    label: "Formas",
    tools: [
      { id: "rect", icon: <Square size={14} />, label: "Retângulo", key: "R" },
      { id: "ellipse", icon: <Circle size={14} />, label: "Elipse", key: "O" },
      { id: "line", icon: <Minus size={14} />, label: "Linha", key: "L" },
      { id: "arrow", icon: <ArrowUpRight size={14} />, label: "Seta", key: "A" },
    ],
  },
  {
    id: "place",
    label: "Inserir",
    tools: [
      { id: "text", icon: <Type size={14} />, label: "Texto", key: "T" },
      { id: "note", icon: <StickyNote size={14} />, label: "Nota", key: "N" },
      { id: "portal", icon: <Globe size={14} />, label: "Portal (navegador)", key: "W" },
    ],
  },
  {
    id: "connect",
    label: "Conectar",
    tools: [
      {
        id: "connect",
        icon: <Spline size={14} />,
        label: "Conectar terminais",
        key: "C",
        // The connection is the bridge's access policy: whoever isn't wired up
        // can't be reached. Saying so in the tooltip is the cheapest place to
        // teach it.
        hint: "o cabo é o que autoriza um agente a falar com o outro",
      },
    ],
  },
  {
    id: "flow",
    label: "Fluxo",
    tools: [
      {
        id: "flow",
        icon: <Workflow size={14} />,
        label: "Fluxo de agentes (encadear em sequência)",
        key: "F",
      },
    ],
  },
];

/** `dot` is the dot inside the flyout; `chip` the one the rail button wears. */
const SIZES: {
  id: StrokeSize;
  dot: number;
  chip: number;
  label: string;
  short: string;
}[] = [
  { id: "s", dot: 3, chip: 7, label: "Traço fino", short: "fino" },
  { id: "m", dot: 5, chip: 10, label: "Traço médio", short: "médio" },
  { id: "l", dot: 8, chip: 13, label: "Traço grosso", short: "grosso" },
];

const STYLE = "style";

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  size: StrokeSize;
  onSize: (s: StrokeSize) => void;
  /** The key a tool answers to, as the tooltip prints it (`""` = none). */
  keyFor: (tool: Tool) => string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export function CanvasToolbar({
  tool,
  onTool,
  color,
  onColor,
  size,
  onSize,
  keyFor,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: Props) {
  /** `(V)` after a label, or nothing when the tool has no key any more. */
  const keyTag = (id: Tool) => {
    const k = keyFor(id);
    return k ? ` (${k})` : "";
  };
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The rail floats over the board: without this a portal card underneath
  // paints the site straight over it, buttons and all.
  useOccluder("cv-toolbar", rootRef);
  /** The face each family wears: the last tool taken from it. */
  const [held, setHeld] = useState<Record<string, Tool>>(() => {
    const seed: Record<string, Tool> = {};
    for (const f of FAMILIES) seed[f.id] = f.tools[0].id;
    return seed;
  });

  // A shortcut key picks a tool without touching the rail, so the family it
  // belongs to has to start wearing it.
  useEffect(() => {
    const family = FAMILIES.find((f) => f.tools.some((t) => t.id === tool));
    if (!family) return;
    setHeld((h) => (h[family.id] === tool ? h : { ...h, [family.id]: tool }));
  }, [tool]);

  // Dismiss like a popover: a press anywhere else, or Esc. Esc is taken
  // on the capture phase so the canvas below doesn't also read it as "clear
  // the selection" — closing what is on top is the whole gesture.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pickFamily = (family: Family) => {
    const isHere = family.tools.some((t) => t.id === tool);
    // Reaching for a family always hands you a tool; the flyout that comes
    // with it is the offer to swap, not a stop on the way.
    if (!isHere) onTool(held[family.id] ?? family.tools[0].id);
    setOpen(family.tools.length > 1 && open !== family.id ? family.id : null);
  };

  const pickTool = (t: Tool) => {
    onTool(t);
    setOpen(null);
  };

  const chip = SIZES.find((s) => s.id === size) ?? SIZES[1];

  return (
    <div
      className="cv-toolbar"
      role="toolbar"
      aria-label={t("Ferramentas do canvas")}
      ref={rootRef}
    >
      {FAMILIES.map((family) => {
        // Holding a tool beats remembering one — otherwise the rail lags a
        // frame behind every pick, since `held` only catches up in an effect.
        const face =
          family.tools.find((t) => t.id === tool) ??
          family.tools.find((t) => t.id === held[family.id]) ??
          family.tools[0];
        const isHere = family.tools.some((t) => t.id === tool);
        const isOpen = open === family.id;
        const many = family.tools.length > 1;
        return (
          <div
            key={family.id}
            className={`cv-tool-family ${isOpen ? "is-open" : ""}`}
          >
            <button
              className={`icon-btn cv-tool-btn ${isHere ? "is-active" : ""}`}
              data-tip-side="right"
              data-tip-wrap={face.hint ? "" : undefined}
              data-tip={`${many ? `${t(family.label)} — ` : ""}${t(face.label)}${keyTag(face.id)}${
                face.hint ? `\n${t(face.hint)}` : ""
              }`}
              aria-label={t(family.label)}
              aria-pressed={isHere}
              aria-haspopup={many ? "true" : undefined}
              aria-expanded={many ? isOpen : undefined}
              onClick={() => pickFamily(family)}
            >
              {face.icon}
              {many && <span className="cv-tool-more" aria-hidden="true" />}
            </button>

            {isOpen && (
              <div className="cv-flyout" role="group" aria-label={t(family.label)}>
                {family.tools.map((td) => (
                  <button
                    key={td.id}
                    className={`icon-btn ${tool === td.id ? "is-active" : ""}`}
                    data-tip-wrap={td.hint ? "" : undefined}
                    data-tip={`${t(td.label)}${keyTag(td.id)}${td.hint ? `\n${t(td.hint)}` : ""}`}
                    aria-label={t(td.label)}
                    aria-pressed={tool === td.id}
                    onClick={() => pickTool(td.id)}
                  >
                    {td.icon}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="cv-toolbar-sep" />

      {/* Ink: one button wearing the current color at the current thickness. */}
      <div className={`cv-tool-family ${open === STYLE ? "is-open" : ""}`}>
        <button
          className="icon-btn cv-tool-btn"
          data-tip-side="right"
          data-tip={t("Cor e traço — {size}", { size: t(chip.short) })}
          aria-label={t("Cor e espessura do traço")}
          aria-haspopup="true"
          aria-expanded={open === STYLE}
          onClick={() => setOpen(open === STYLE ? null : STYLE)}
        >
          <span
            className="cv-ink"
            style={{ background: color, width: chip.chip, height: chip.chip }}
          />
          <span className="cv-tool-more" aria-hidden="true" />
        </button>

        {open === STYLE && (
          <div className="cv-flyout cv-flyout--style" role="group" aria-label={t("Cor e traço")}>
            <div className="cv-swatches">
              {CANVAS_COLORS.map((c) => (
                <button
                  key={c}
                  className={`cv-swatch ${color === c ? "is-active" : ""}`}
                  style={{ background: c }}
                  data-tip={c}
                  aria-label={t("Cor {c}", { c })}
                  aria-pressed={color === c}
                  onClick={() => onColor(c)}
                />
              ))}
            </div>

            <div className="cv-flyout-sep" />

            <div className="cv-sizes">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  className={`icon-btn ${size === s.id ? "is-active" : ""}`}
                  data-tip={t(s.label)}
                  aria-label={t(s.label)}
                  aria-pressed={size === s.id}
                  onClick={() => onSize(s.id)}
                >
                  <span className="cv-size-dot" style={{ width: s.dot, height: s.dot }} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="cv-toolbar-sep" />

      <button
        className="icon-btn"
        data-tip-side="right" data-tip={t("Desfazer (Ctrl+Z)")}
        aria-label={t("Desfazer")}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 size={14} />
      </button>
      <button
        className="icon-btn"
        data-tip-side="right" data-tip={t("Refazer (Ctrl+Y)")}
        aria-label={t("Refazer")}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}
