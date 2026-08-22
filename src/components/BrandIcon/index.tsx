/**
 * The mark of a program, at the size of the chrome around it.
 *
 * `BrandIcon` draws a logo from `marks.ts`; `TerminalMark` is what the call
 * sites use, because it answers the whole question — "what is running here?"
 * — and falls back to the generic Lucide glyph (robot for an agent, screen for
 * a shell) when the program has no mark of its own. Nothing chooses the icon
 * inline anymore: the tab, the tree row and the card would drift apart the
 * moment one of them learned about a new CLI and the others did not.
 *
 * In the product's own color, not `currentColor`: at 12px a white blob beside
 * another white blob is still "some CLI", and the coral of Claude or the green
 * of Bash is recognized before the shape is. The color lives with the geometry
 * in `marks.ts`; the marks that are genuinely monochrome stay white there.
 * Only these logos are tinted — the rest of the chrome keeps the single blue.
 */
import { useId } from "react";
import { Bot, Terminal as TerminalIcon } from "lucide-react";

import { MARKS } from "./marks";
import { brandOf, type BrandId } from "../../lib/brands";
import type { PtyKind } from "../../lib/ipc";

interface IconProps {
  size?: number;
  className?: string;
}

export function BrandIcon({
  brand,
  size = 12,
  className,
}: IconProps & { brand: BrandId }) {
  const mark = MARKS[brand];
  // The same mark can sit in a dozen rows at once, and a gradient id shared
  // between them would be a duplicate in the document; `useId` gives each copy
  // its own (its colons are not welcome inside `url(#…)`).
  const gradId = `brand-${brand}-${useId().replace(/:/g, "")}`;
  // Two ways of drawing in one box: the borrowed logos are filled shapes, our
  // own prompt glyphs are strokes at Lucide's weight.
  const paint = mark.stroke
    ? ({
        fill: "none",
        stroke: mark.color,
        strokeWidth: mark.stroke,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      } as const)
    : ({
        fill: mark.stops ? `url(#${gradId})` : mark.color,
        fillRule: mark.rule,
      } as const);

  return (
    <svg
      className={className ? `brand-icon ${className}` : "brand-icon"}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      {...paint}
    >
      {mark.stops && (
        // Down the diagonal, which is where both gradient marks turn.
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          {mark.stops.map((s) => (
            <stop key={`${s.at}-${s.color}`} offset={s.at} stopColor={s.color} />
          ))}
        </linearGradient>
      )}
      {mark.d.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The icon of one terminal: its product's mark, or the generic glyph. */
export function TerminalMark({
  term,
  size = 12,
  className,
}: IconProps & {
  term: { kind: PtyKind; agentId?: string | null; program: string };
}) {
  const brand = brandOf(term);
  if (brand) return <BrandIcon brand={brand} size={size} className={className} />;
  const Fallback = term.kind === "agent" ? Bot : TerminalIcon;
  return <Fallback size={size} className={className} aria-hidden="true" />;
}
