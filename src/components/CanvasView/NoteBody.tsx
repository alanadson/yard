/**
 * The body of a note **outside** edit mode: lightweight rendered markdown.
 *
 * Editing is still a raw `<textarea>` (the user sees what agents
 * read via the CLI, no formatting surprise). Here is reading only.
 *
 * Memoized, and that is not decoration: `NoteItem` re-renders on every frame
 * of a drag (its `dx`/`dy` change per frame), and without the bail-out here
 * the markdown would be re-parsed 60 times a second for text nobody touched.
 */
import { memo } from "react";

import { parseMarkdown, type Inline } from "../../lib/markdown";

interface Props {
  text: string;
  placeholder: string;
}

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === "strong") return <strong key={i}>{p.v}</strong>;
        if (p.t === "em") return <em key={i}>{p.v}</em>;
        if (p.t === "code") return <code key={i}>{p.v}</code>;
        return <span key={i}>{p.v}</span>;
      })}
    </>
  );
}

function NoteBodyImpl({ text, placeholder }: Props) {
  if (!text.trim()) {
    return <div className="cv-note-md is-empty">{placeholder}</div>;
  }
  const blocks = parseMarkdown(text);
  return (
    <div className="cv-note-md">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const Tag = (["h1", "h2", "h3"] as const)[b.level - 1];
            return (
              <Tag key={i}>
                <Parts parts={b.parts} />
              </Tag>
            );
          }
          case "li":
            return (
              <div key={i} className="cv-md-li">
                <span className="cv-md-marker">{b.marker}</span>
                <span>
                  <Parts parts={b.parts} />
                </span>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Parts parts={b.parts} />
              </blockquote>
            );
          case "pre":
            return <pre key={i}>{b.v}</pre>;
          case "hr":
            return <hr key={i} />;
          case "blank":
            return <div key={i} className="cv-md-blank" />;
          default:
            return (
              <p key={i}>
                <Parts parts={b.parts} />
              </p>
            );
        }
      })}
    </div>
  );
}

export const NoteBody = memo(NoteBodyImpl);
