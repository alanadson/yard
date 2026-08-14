/**
 * Canvas tools: select, hand, pen, eraser, shapes, text, note
 * and connect, plus color, stroke width and undo. Vertical on the left edge so
 * it doesn't fight the title bar or the cards.
 */
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
} from "lucide-react";

import { CANVAS_COLORS, type StrokeSize } from "../../lib/canvas";

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
  | "connect";

const TOOLS: { id: Tool; icon: React.ReactNode; label: string; key: string }[] = [
  { id: "select", icon: <MousePointer2 size={14} />, label: "Selecionar", key: "V" },
  { id: "pan", icon: <Hand size={14} />, label: "Mover a tela", key: "H" },
  { id: "pen", icon: <Pencil size={14} />, label: "Caneta", key: "P" },
  { id: "eraser", icon: <Eraser size={14} />, label: "Borracha", key: "E" },
  { id: "rect", icon: <Square size={14} />, label: "Retângulo", key: "R" },
  { id: "ellipse", icon: <Circle size={14} />, label: "Elipse", key: "O" },
  { id: "line", icon: <Minus size={14} />, label: "Linha", key: "L" },
  { id: "arrow", icon: <ArrowUpRight size={14} />, label: "Seta", key: "A" },
  { id: "text", icon: <Type size={14} />, label: "Texto", key: "T" },
  { id: "note", icon: <StickyNote size={14} />, label: "Nota", key: "N" },
  { id: "portal", icon: <Globe size={14} />, label: "Portal (navegador)", key: "W" },
  { id: "connect", icon: <Spline size={14} />, label: "Conectar terminais", key: "C" },
];

const SIZES: { id: StrokeSize; dot: number; label: string }[] = [
  { id: "s", dot: 3, label: "Traço fino" },
  { id: "m", dot: 5, label: "Traço médio" },
  { id: "l", dot: 8, label: "Traço grosso" },
];

interface Props {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  size: StrokeSize;
  onSize: (s: StrokeSize) => void;
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: Props) {
  return (
    <div className="cv-toolbar" role="toolbar" aria-label="Ferramentas do canvas">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`icon-btn ${tool === t.id ? "is-active" : ""}`}
          data-tip-side="right" data-tip={`${t.label} (${t.key})`}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          onClick={() => onTool(t.id)}
        >
          {t.icon}
        </button>
      ))}

      <div className="cv-toolbar-sep" />

      <div className="cv-swatches">
        {CANVAS_COLORS.map((c) => (
          <button
            key={c}
            className={`cv-swatch ${color === c ? "is-active" : ""}`}
            style={{ background: c }}
            data-tip-side="right" data-tip={c}
            aria-label={`Cor ${c}`}
            aria-pressed={color === c}
            onClick={() => onColor(c)}
          />
        ))}
      </div>

      <div className="cv-sizes">
        {SIZES.map((s) => (
          <button
            key={s.id}
            className={`icon-btn ${size === s.id ? "is-active" : ""}`}
            data-tip-side="right" data-tip={s.label}
            aria-label={s.label}
            aria-pressed={size === s.id}
            onClick={() => onSize(s.id)}
          >
            <span className="cv-size-dot" style={{ width: s.dot, height: s.dot }} />
          </button>
        ))}
      </div>

      <div className="cv-toolbar-sep" />

      <button
        className="icon-btn"
        data-tip-side="right" data-tip="Desfazer (Ctrl+Z)"
        aria-label="Desfazer"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 size={14} />
      </button>
      <button
        className="icon-btn"
        data-tip-side="right" data-tip="Refazer (Ctrl+Y)"
        aria-label="Refazer"
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </button>
    </div>
  );
}
