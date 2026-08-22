/**
 * Project icon + color picker, used when creating and when customizing.
 *
 * Two independent sections: a scrollable grid of ready-made icons and a
 * row of color dots (the first is the theme's neutral). Both are real
 * radiogroups — keyboard navigates, screen reader announces.
 */
import { PROJECT_COLORS, PROJECT_ICONS } from "../../lib/projectStyle";

interface Props {
  icon: string;
  color: string | null;
  onIcon: (icon: string) => void;
  onColor: (color: string | null) => void;
}

export function ProjectStylePicker({ icon, color, onIcon, onColor }: Props) {
  // The selected icon takes the chosen color in the grid itself: the user
  // sees the final combination without a separate preview.
  const tint = color ?? undefined;

  return (
    <>
      <div className="picker-field">
        <span className="picker-label" id="picker-icones">
          Ícone
        </span>
        <div className="icon-grid" role="radiogroup" aria-labelledby="picker-icones">
          {Object.entries(PROJECT_ICONS).map(([name, Icon]) => {
            const active = name === icon;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={name}
                className={`icon-cell ${active ? "is-active" : ""}`}
                style={active && tint ? { color: tint } : undefined}
                onClick={() => onIcon(name)}
              >
                <Icon size={20} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="picker-field">
        <span className="picker-label" id="picker-cores">
          Cor
        </span>
        <div className="color-row" role="radiogroup" aria-labelledby="picker-cores">
          {PROJECT_COLORS.map((c) => {
            const active = c === color;
            return (
              <button
                key={c ?? "neutro"}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={c ?? "Sem cor"}
                data-tip={c ?? "Sem cor"}
                className={`color-dot ${c === null ? "color-dot--none" : ""} ${
                  active ? "is-active" : ""
                }`}
                style={c ? { background: c } : undefined}
                onClick={() => onColor(c)}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}
