import type { ReactNode } from "react";
import { PinOff } from "lucide-react";
import { dockWorldRect, type DockSide } from "../../lib/canvasDock";
import type { CanvasViewport } from "../../lib/canvas";
import type { MenuEntry } from "../ContextMenu";
import { useT } from "../../hooks/useT";

export function dockMenu(
  t: ReturnType<typeof useT>,
  side: DockSide | undefined,
  change: (side: DockSide | undefined) => void,
): MenuEntry {
  return {
    id: "dock",
    label: t("Encaixar na lateral"),
    submenu: [
      {
        id: "dock-left",
        label: t("Esquerda"),
        checked: side === "left",
        onSelect: () => change("left"),
      },
      {
        id: "dock-right",
        label: t("Direita"),
        checked: side === "right",
        onSelect: () => change("right"),
      },
      {
        id: "dock-release",
        label: t("Soltar do encaixe"),
        disabled: !side,
        onSelect: () => change(undefined),
      },
    ],
  };
}

export function DockFrame({
  id,
  side,
  viewport,
  size,
  onRelease,
  children,
}: {
  id: string;
  side?: DockSide;
  viewport: CanvasViewport;
  size: { w: number; h: number };
  onRelease: () => void;
  children: ReactNode;
}) {
  const t = useT();
  if (!side) return <>{children}</>;
  const box = dockWorldRect(side, viewport, size);
  return (
    <div
      className="cv-dock"
      data-dock-id={id}
      style={{
        left: box.x,
        top: box.y,
        width: box.w * viewport.zoom,
        height: box.h * viewport.zoom,
        transform: `scale(${1 / viewport.zoom})`,
      }}
    >
      {children}
      <button
        className="cv-dock-release"
        aria-label={t("Soltar do encaixe")}
        data-tip={t("Soltar do encaixe")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRelease}
      >
        <PinOff size={12} />
      </button>
    </div>
  );
}
