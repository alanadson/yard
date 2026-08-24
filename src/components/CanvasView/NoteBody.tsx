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
import { memo, useEffect, useState } from "react";

import { mediaUrl } from "../../lib/media";
import { parseMarkdown, type Inline } from "../../lib/markdown";

interface Props {
  text: string;
  placeholder: string;
  /**
   * Project root a relative image path is resolved against. Empty on a board
   * (`quadro`), which belongs to no project — there a picture has to carry a
   * `data:` URL or a full address, and a bare path shows as a missing file
   * rather than guessing a folder.
   */
  root: string;
  /** Ticks or unticks the task on that source line. */
  onTask: (line: number) => void;
  onLink: (href: string) => void;
}

/** Indent step of a nested list item, in `em` so it follows the note's size. */
const STEP = 1.1;

function Parts({
  parts,
  onLink,
  root,
}: {
  parts: Inline[];
  onLink: (href: string) => void;
  root: string;
}) {
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
        if (p.t === "img") return <NoteImage key={i} src={p.src} alt={p.alt} root={root} />;
        return <span key={i}>{p.v}</span>;
      })}
    </>
  );
}

/**
 * A picture inside a note (§12.3).
 *
 * Three addresses are possible and only one of them costs anything: a
 * `data:` URL (a pasted print, already inline), an `http(s)` one, and — the
 * common case — a path relative to the **project root**. A note has no file of
 * its own to be relative to, so the project is the only anchor that means
 * anything; `![](docs/shot.png)` is the same path the agent would type in a
 * terminal.
 *
 * The bytes never cross the IPC: `yardfile://` is the same protocol the file
 * viewer uses, so the webview fetches the image itself and a 12 MB screenshot
 * costs one request instead of a base64 string through a JSON channel.
 */
function NoteImage({ src, alt, root }: { src: string; alt: string; root: string }) {
  const [failed, setFailed] = useState(false);
  const external = /^(data:|https?:)/i.test(src);
  const url = external ? src : root ? mediaUrl(root, src) : null;
  // The agent moved the file the note points at: try the new address.
  useEffect(() => setFailed(false), [url]);

  if (!url || failed) {
    // A missing picture says which file it wanted. A broken frame with no
    // explanation is the worst of both worlds.
    return (
      <span className="cv-md-img-miss" data-tip={src}>
        {alt || src}
      </span>
    );
  }
  return (
    <img
      className="cv-md-img"
      src={url}
      alt={alt}
      title={alt || undefined}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function NoteBodyImpl({ text, placeholder, root, onTask, onLink }: Props) {
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
                <Parts parts={b.parts} onLink={onLink} root={root} />
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
                  <Parts parts={b.parts} onLink={onLink} root={root} />
                </span>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <Parts parts={b.parts} onLink={onLink} root={root} />
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
          case "table":
            return (
              // Its own scroller: a wide table must not push the note's body
              // sideways — the note has a fixed box on the board and a column
              // that overflows would simply be unreachable.
              <div key={i} className="cv-md-tablewrap">
                <table className="cv-md-table">
                  <thead>
                    <tr>
                      {b.head.map((cell, c) => (
                        <th key={c} style={{ textAlign: b.align[c] }}>
                          <Parts parts={cell} onLink={onLink} root={root} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} style={{ textAlign: b.align[c] }}>
                            <Parts parts={cell} onLink={onLink} root={root} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return (
              <p key={i}>
                <Parts parts={b.parts} onLink={onLink} root={root} />
              </p>
            );
        }
      })}
    </div>
  );
}

export const NoteBody = memo(NoteBodyImpl);
