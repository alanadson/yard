import { Maximize, Minimize } from "lucide-react";
import { useT } from "../../hooks/useT";
import type { BoxItem } from "../../lib/itemSizing";

export function ItemMaximizeButton({
  item,
  onMaximize,
}: {
  item: BoxItem;
  onMaximize: (id: string) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="cv-item-maximize"
      aria-label={
        item.restore ? t("Restaurar o tamanho") : t("Maximizar no canvas")
      }
      data-tip={
        item.pinned
          ? t("Fixado no lugar")
          : item.restore
            ? t("Restaurar o tamanho")
            : t("Maximizar no canvas")
      }
      disabled={item.pinned}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onMaximize(item.id);
      }}
    >
      {item.restore ? <Minimize size={13} /> : <Maximize size={13} />}
    </button>
  );
}
