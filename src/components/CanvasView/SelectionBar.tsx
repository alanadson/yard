/**
 * The bar that appears over a multi-selection: align, distribute, tidy.
 *
 * It floats instead of living in the left toolbar because these actions have
 * no meaning without a selection — a permanent row of nine disabled buttons
 * teaches nothing, while a bar that materializes the moment you rubber-band
 * four cards says what it is for by showing up.
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  LayoutGrid,
} from "lucide-react";

import type { AlignKind, DistributeKind } from "../../lib/arrange";
import { useT } from "../../hooks/useT";

interface Props {
  /** Screen position of the top-center of the selection, in px. */
  at: { x: number; y: number };
  count: number;
  /** Distribute needs three boxes to have anything to even out. */
  canDistribute: boolean;
  onAlign: (kind: AlignKind) => void;
  onDistribute: (kind: DistributeKind) => void;
  onTidy: () => void;
}

// i18n-scan: tables — the labels are wrapped with t() where they are rendered.
const ALIGNS: { id: AlignKind; icon: React.ReactNode; label: string }[] = [
  { id: "left", icon: <AlignStartVertical size={13} />, label: "Alinhar à esquerda" },
  { id: "hcenter", icon: <AlignCenterVertical size={13} />, label: "Centralizar na horizontal" },
  { id: "right", icon: <AlignEndVertical size={13} />, label: "Alinhar à direita" },
  { id: "top", icon: <AlignStartHorizontal size={13} />, label: "Alinhar pelo topo" },
  { id: "vcenter", icon: <AlignCenterHorizontal size={13} />, label: "Centralizar na vertical" },
  { id: "bottom", icon: <AlignEndHorizontal size={13} />, label: "Alinhar pela base" },
];

export function SelectionBar({
  at,
  count,
  canDistribute,
  onAlign,
  onDistribute,
  onTidy,
}: Props) {
  const t = useT();
  return (
    <div
      className="cv-selbar"
      style={{ left: at.x, top: at.y }}
      role="toolbar"
      aria-label={t("Arranjo da seleção")}
      // The bar sits inside the canvas, and a pointerdown that reaches the
      // background clears the very selection the bar acts on.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="cv-selbar-count">{count}</span>
      <div className="cv-selbar-sep" />
      {ALIGNS.map((a) => (
        <button
          key={a.id}
          className="icon-btn"
          data-tip-side="top"
          data-tip={t(a.label)}
          aria-label={t(a.label)}
          onClick={() => onAlign(a.id)}
        >
          {a.icon}
        </button>
      ))}
      <div className="cv-selbar-sep" />
      <button
        className="icon-btn"
        data-tip-side="top"
        data-tip={t("Distribuir na horizontal")}
        aria-label={t("Distribuir na horizontal")}
        disabled={!canDistribute}
        onClick={() => onDistribute("h")}
      >
        <AlignHorizontalDistributeCenter size={13} />
      </button>
      <button
        className="icon-btn"
        data-tip-side="top"
        data-tip={t("Distribuir na vertical")}
        aria-label={t("Distribuir na vertical")}
        disabled={!canDistribute}
        onClick={() => onDistribute("v")}
      >
        <AlignVerticalDistributeCenter size={13} />
      </button>
      <div className="cv-selbar-sep" />
      <button
        className="icon-btn"
        data-tip-side="top"
        data-tip={t("Organizar em grade (Ctrl+Shift+T) — de novo troca o layout")}
        data-tip-wrap=""
        aria-label={t("Organizar em grade")}
        onClick={onTidy}
      >
        <LayoutGrid size={13} />
      </button>
    </div>
  );
}
