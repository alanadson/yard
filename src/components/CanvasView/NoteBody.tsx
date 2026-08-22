/**
 * The body of a note **outside** edit mode: lightweight rendered markdown.
 *
 * Editing is still a raw `<textarea>` (the user sees what agents
 * read via the CLI, no formatting surprise). Here is reading only — with two
 * exceptions that earn their keep: a checkbox you can tick without opening
 * the editor, and a link you can follow.
 *
 * Memoized, and that is not decoration: `NoteItem` re-renders on every frame
 * of a drag (its `dx`/`dy` change per frame), and without the bail-out here
 * the markdown would be re-parsed 60 times a second for text nobody touched.
 * Every callback below has to be stable in the parent for that to hold.
 */
import { memo } from "react";

import { parseMarkdown, type Inline } from "../../lib/markdown";

interface Props {
  text: string;
  placeholder: string;
  /** Ticks or unticks the task on that source line. */
  onTask: (line: number) => void;
  onLink: (href: string) => void;
}

/** Indent step of a nested list item, in `em` so it follows the note's size. */
const STEP = 1.1;

function Parts({ parts, onLink }: { parts: Inline[]; onLink: (href: string) => void }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.t === "strong") return <strong key={i}>{p.v}</strong>;
        if (p.t === "em") return <em key={i}>{p.v}</em>;
        if (p.t === "code") return <code key={i}>{p.v}</code>;
        if (p.t === "strike") return <s key={i}>{p.v}</s>;
        if (p.t === "mark") return <mark key={i}>{p.v}</mark>;
        if (p.t === "link") {
          // No `href`: a real one would let a stray click navigate the whole
          // app away inside the webview. The click opens the address as a
          // portal on the canvas instead, which is where the web lives here.
          return (
            <a
              key={i}
              className="cv-md-link"
              role="link"
              tabIndex={0}
              data-tip={p.href}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onLink(p.href);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onLink(p.href);
              }}
            >
              {p.v}
            </a>
          );
        }
        return <span key={i}>{p.v}</span>;
      })}
    </>
  );
}

function NoteBodyImpl({ text, placeholder, onTask, onLink }: Props) {
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
                <Parts parts={b.parts} onLink={onLink} />
              </Tag>
            );
          }
          case "li":
            return (
              <div
                key={i}
                className={`cv-md-li ${b.task === "done" ? "is-done" : ""}`}
                style={b.depth ? { paddingLeft: `${b.depth * STEP}em` } : undefined}
              >
                {b.task ? (
                  <button
                    className="cv-md-check"
                    role="checkbox"
                    aria-checked={b.task === "done"}
                    aria-label={b.task === "done" ? "Reabrir a tarefa" : "Concluir a tarefa"}
                    // The note body turns a click into "edit this note"; a
                    // checkbox has to keep its own click to itself, press and
                    // release both, or ticking it would open the editor too.
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onTask(b.line);
                    }}
                  />
                ) : (
                  <span className="cv-md-marker">{b.marker}</span>
                )}
                <span>
                  <Parts parts={b.parts} onLink={onLink} />
                </span>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Parts parts={b.parts} onLink={onLink} />
              </blockquote>
            );
          case "pre":
            return (
              <pre key={i} data-lang={b.lang}>
                {b.v}
              </pre>
            );
          case "hr":
            return <hr key={i} />;
          case "blank":
            return <div key={i} className="cv-md-blank" />;
          default:
            return (
              <p key={i}>
                <Parts parts={b.parts} onLink={onLink} />
              </p>
            );
        }
      })}
    </div>
  );
}

export const NoteBody = memo(NoteBodyImpl);
