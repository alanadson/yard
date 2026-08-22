/**
 * A ```math (or ```katex/```latex) fence, drawn as a formula — the KaTeX
 * extension's whole surface.
 *
 * Self-gating like `MermaidBlock`: off, loading or unparseable → the ordinary
 * code block. The injected markup is KaTeX's own render of the TeX source —
 * escaped spans, no scripts — which is the same documented exception to the
 * preview's no-HTML rule.
 */
import { useEffect, useState, type ReactNode } from "react";

import { useExtensions } from "../../stores/extensionsStore";

export function KatexBlock({ text, fallback }: { text: string; fallback: ReactNode }) {
  const on = useExtensions((s) => s.enabled.katex === true);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    setHtml(null);
    void Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([katex]) => {
        if (!alive) return;
        setHtml(
          katex.default.renderToString(text, {
            displayMode: true,
            throwOnError: true,
          }),
        );
      })
      .catch(() => {
        /* bad TeX: the fence stays a code block */
      });
    return () => {
      alive = false;
    };
  }, [on, text]);

  if (!on || html === null) return <>{fallback}</>;
  return (
    <div
      className="md-katex"
      // KaTeX's own escaped output — see the header comment.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
