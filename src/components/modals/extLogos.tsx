/**
 * The face of each extension — the same everywhere the list shows up.
 *
 * Moved out of the store when the Extensions category in Settings started
 * listing the same extensions: two visual identities for the same thing (the
 * store with the real logo, the panel with a letter) make the user look
 * twice. The color-scheme logos are born from the palette itself — data, not
 * a screenshot — and the `viewBox` of 44 lets the drawing scale on its own
 * to the panel's 32px frame.
 */
import symbolsLogo from "../FileGlyph/symbols/logo.png";
import { schemeFor, type ColorScheme } from "../../lib/colorSchemes";
import { type ExtensionDef } from "../../lib/extensions";

const MONO = "ui-monospace, Consolas, monospace";

// ---------------------------------------------------------------------------
// color-scheme cards — logo and preview generated from the palette itself
// ---------------------------------------------------------------------------

export function SchemeLogo({ scheme }: { scheme: ColorScheme }) {
  const dots = [scheme.term.red, scheme.term.yellow, scheme.term.blue, scheme.term.magenta];
  return (
    <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
      {/* Same squircle as the tile behind it — the palette reads as a mini
          app icon, not a sticker on a plate. */}
      <rect x="1" y="1" width="42" height="42" rx="11.5" fill={scheme.term.background} />
      {dots.map((c, i) => (
        <circle
          key={i}
          cx={15 + (i % 2) * 14}
          cy={15 + Math.floor(i / 2) * 14}
          r="4.6"
          fill={c}
        />
      ))}
    </svg>
  );
}

export function SchemePreview({ scheme }: { scheme: ColorScheme }) {
  const { term, syntax } = scheme;
  const ansi = [
    term.black,
    term.red,
    term.green,
    term.yellow,
    term.blue,
    term.magenta,
    term.cyan,
    term.white,
  ];
  return (
    <div className="ext-preview" aria-hidden="true" style={{ background: term.background }}>
      {ansi.map((c, i) => (
        <span key={i} className="ext-swatch" style={{ background: c }} />
      ))}
      <span className="ext-preview-item" style={{ color: term.foreground }}>
        <span style={{ color: syntax.keyword }}>const</span>
        <span style={{ color: syntax.function }}>soma</span>
        <span style={{ color: syntax.operator }}>=</span>
        <span style={{ color: syntax.number }}>(2)</span>
        <span style={{ color: syntax.string }}>"ok"</span>
        <span style={{ color: syntax.comment, fontStyle: "italic" }}>// comentário</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// one-off logos for the functional extensions
// ---------------------------------------------------------------------------

function TextLogo({ text, color, size = 17 }: { text: string; color: string; size?: number }) {
  return (
    <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
      <text
        x="22"
        y="24"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size}
        fontWeight="700"
        fill={color}
        fontFamily={MONO}
      >
        {text}
      </text>
    </svg>
  );
}

export function logoOf(ext: ExtensionDef) {
  const scheme = schemeFor(ext.id);
  if (scheme) return <SchemeLogo scheme={scheme} />;
  switch (ext.id) {
    case "symbols":
      return <img src={symbolsLogo} width={44} height={44} alt="" draggable={false} />;
    case "material-icons":
      return (
        <img src="/material-icons/folder.svg" width={34} height={34} alt="" draggable={false} />
      );
    case "code-fonts":
      return <TextLogo text="Aa" color="#79c0ff" size={20} />;
    case "rainbow-brackets":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <g fontSize="19" fontWeight="700" fontFamily={MONO} dominantBaseline="central">
            <text x="6" y="24" fill="#e3b341">{"{"}</text>
            <text x="17" y="24" fill="#f778ba">{"("}</text>
            <text x="24" y="24" fill="#79c0ff">{")"}</text>
            <text x="31" y="24" fill="#e3b341">{"}"}</text>
          </g>
        </svg>
      );
    case "todo-highlight":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <rect x="8" y="8" width="28" height="28" rx="7" fill="rgb(227 179 65 / 22%)" />
          <path
            d="m15 22.5 5 5 9-10"
            fill="none"
            stroke="#e3b341"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "minimap":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <rect x="8" y="10" width="18" height="24" rx="2" fill="rgb(255 255 255 / 14%)" />
          <rect x="29" y="10" width="7" height="24" rx="1.6" fill="rgb(121 192 255 / 45%)" />
          <rect x="29" y="16" width="7" height="7" rx="1.6" fill="#79c0ff" />
        </svg>
      );
    case "indent-guides":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <g stroke="rgb(255 255 255 / 35%)" strokeWidth="2" strokeLinecap="round">
            <path d="M14 10v24" />
            <path d="M22 14v16" stroke="#79c0ff" />
            <path d="M30 18v8" />
          </g>
        </svg>
      );
    case "css-colors":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="3" fill="#0a84ff" />
          <rect x="23" y="9" width="12" height="12" rx="3" fill="#f778ba" />
          <rect x="9" y="23" width="12" height="12" rx="3" fill="#7ee787" />
          <rect x="23" y="23" width="12" height="12" rx="3" fill="#e3b341" />
        </svg>
      );
    case "format-on-save":
      return <TextLogo text="{…}" color="#7ee787" size={15} />;
    case "term-images":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <rect
            x="8"
            y="10"
            width="28"
            height="24"
            rx="3"
            fill="none"
            stroke="#79c0ff"
            strokeWidth="2.4"
          />
          <circle cx="16.5" cy="18" r="2.4" fill="#e3b341" />
          <path
            d="m11 29 7-7 5 5 4-4 6 6"
            fill="none"
            stroke="#7ee787"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "mermaid":
      return (
        <svg viewBox="0 0 44 44" width={44} height={44} aria-hidden="true">
          <rect x="16" y="7" width="12" height="9" rx="2.4" fill="#f778ba" />
          <rect x="7" y="28" width="12" height="9" rx="2.4" fill="#79c0ff" />
          <rect x="25" y="28" width="12" height="9" rx="2.4" fill="#7ee787" />
          <path
            d="M22 16v6m0 0-9 6m9-6 9 6"
            fill="none"
            stroke="rgb(255 255 255 / 45%)"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "katex":
      return <TextLogo text="∑" color="#d2a8ff" size={22} />;
  }
}
