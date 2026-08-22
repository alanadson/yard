/**
 * A ```mermaid fence, drawn — the Mermaid extension's whole surface.
 *
 * Self-gating: with the extension off (or while the chunk loads, or when the
 * diagram does not parse) it renders the `fallback` — the ordinary code
 * block — so a broken diagram is never a broken page.
 *
 * This is the documented exception to the preview's no-HTML rule: Mermaid
 * produces SVG markup, generated locally from the fence's text with
 * `securityLevel: "strict"` (labels sanitized, no scripts, no foreign
 * content). Nothing remote, nothing executable.
 */
import { useEffect, useState, type ReactNode } from "react";

import { useExtensions } from "../../stores/extensionsStore";

let inited = false;
let seq = 0;

export function MermaidBlock({ text, fallback }: { text: string; fallback: ReactNode }) {
  const on = useExtensions((s) => s.enabled.mermaid === true);
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    setSvg(null);
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (!inited) {
          inited = true;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "dark",
            darkMode: true,
            fontFamily: "var(--ui-font, sans-serif)",
          });
        }
        const out = await mermaid.render(`yard-mermaid-${++seq}`, text);
        if (alive) setSvg(out.svg);
      })
      .catch(() => {
        /* unparseable diagram: the fence stays a code block */
      });
    return () => {
      alive = false;
    };
  }, [on, text]);

  if (!on || svg === null) return <>{fallback}</>;
  return (
    <div
      className="md-mermaid"
      // Locally generated, strict-sanitized SVG — see the header comment.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
