/**
 * The rendered side of a markdown file — what the "Ler" and "Dividido" modes
 * show, and the second half of the editor's markdown experience.
 *
 * Three rules it never breaks:
 *
 * - **Nothing is injected as HTML.** `mddoc.ts` hands over a data tree and
 *   this file paints it with React. The text belongs to agents as much as to
 *   the user, and a preview is exactly where a `<script>` would like to be.
 * - **Every block knows its source line.** That is what makes the reading
 *   view *live*: a checkbox flips the line it came from, the outline jumps to
 *   a heading, and the split view scrolls the preview to what the caret is
 *   writing. Nothing here counts blocks to guess a position.
 * - **Images come through the backend.** A path on disk does not load on its
 *   own, and a remote address must not: a picture from the project is served
 *   by the `yardfile` protocol (`lib/media.ts`), which only ever hands over a
 *   file from inside the root. Any other address shows as a link.
 */
import { Fragment, memo, useEffect, useState, type ReactNode } from "react";
import { LanguageDescription } from "@codemirror/language";
import { Check, Copy, ExternalLink, ImageOff } from "lucide-react";

import { fenceLabel, fenceLanguages } from "./languages";
import { KatexBlock } from "./KatexBlock";
import { MermaidBlock } from "./MermaidBlock";
import { chunkNodes, shineLines } from "./shine";
import { mediaUrl } from "../../lib/media";
import { parseDoc, plain, type Block, type Inline } from "../../lib/mddoc";
import { splitPath } from "../../lib/paths";

interface Props {
  text: string;
  /** Project root of the document — images and relative links hang off it. */
  root: string;
  /** The document's own path, relative to the root. */
  path: string;
  /** Tick or untick the task on that source line. */
  onTask: (line: number) => void;
  /** A relative link that points at another file in the project. */
  onOpenPath: (path: string) => void;
  /** An address for the web — it opens as a portal on the canvas. */
  onOpenUrl: (href: string) => void;
  /** Double-click on a block: the split view puts the caret on that line. */
  onGoToLine?: (line: number) => void;
}

/**
 * Resolves `../img/a.png` against the document's directory.
 *
 * Returns `null` for anything that climbs out of the project: the backend
 * would refuse it anyway, and failing here keeps the preview from asking.
 */
export function resolveRelative(docPath: string, href: string): string | null {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean) return null;
  const base = clean.startsWith("/") ? [] : splitPath(docPath).dir.split("/").filter(Boolean);
  const parts = clean.replace(/^\//, "").split("/");
  const out = [...base];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || null;
}

const isExternal = (href: string) => /^(https?:)?\/\//i.test(href) || /^www\./i.test(href);

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

function MdImage({
  root,
  docPath,
  src,
  alt,
  title,
  onOpenUrl,
}: {
  root: string;
  docPath: string;
  src: string;
  alt: string;
  title?: string;
  onOpenUrl: (href: string) => void;
}) {
  const rel = isExternal(src) || src.startsWith("data:") ? null : resolveRelative(docPath, src);
  /**
   * The address of the picture — nothing is copied to get one on screen.
   *
   * It used to be `fs_read_data_url`: the whole file crossing the IPC as
   * base64, a 24-image cache to make that bearable, and a hard 12 MB ceiling
   * above which a screenshot simply did not appear. As a URL it is the webview
   * that fetches it, and the same protocol the editor's viewer uses.
   */
  const url = rel ? mediaUrl(root, rel) : src.startsWith("data:") ? src : null;
  const [failed, setFailed] = useState(false);
  // The agent moved the file the document points at: try the new address.
  useEffect(() => setFailed(false), [url]);

  if (url && !failed) {
    return (
      <img
        className="md-img"
        src={url}
        alt={alt}
        title={title ?? alt}
        onError={() => setFailed(true)}
      />
    );
  }

  // Remote or refused. A missing picture says which file it wanted instead of
  // leaving a broken frame with no explanation.
  const remote = !rel;
  return (
    <span
      className="md-img-miss"
      role={remote ? "button" : undefined}
      tabIndex={remote ? 0 : undefined}
      onClick={remote ? () => onOpenUrl(src) : undefined}
      onKeyDown={
        remote
          ? (e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpenUrl(src);
            }
          : undefined
      }
      data-tip={
        remote
          ? "Imagem de fora do projeto — abre como portal no canvas"
          : failed
            ? "Não consegui ler o arquivo"
            : undefined
      }
    >
      {remote ? <ExternalLink size={12} /> : <ImageOff size={12} />}
      <span>{alt || src}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

interface InlineProps {
  parts: Inline[];
  root: string;
  docPath: string;
  onOpenPath: (path: string) => void;
  onOpenUrl: (href: string) => void;
}

function Parts({ parts, ...rest }: InlineProps) {
  return (
    <>
      {parts.map((p, i) => {
        switch (p.t) {
          case "text":
            return <span key={i}>{p.v}</span>;
          case "code":
            return <code key={i}>{p.v}</code>;
          case "strong":
            return (
              <strong key={i}>
                <Parts parts={p.parts} {...rest} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Parts parts={p.parts} {...rest} />
              </em>
            );
          case "strike":
            return (
              <s key={i}>
                <Parts parts={p.parts} {...rest} />
              </s>
            );
          case "mark":
            return (
              <mark key={i}>
                <Parts parts={p.parts} {...rest} />
              </mark>
            );
          case "sub":
            return (
              <sub key={i}>
                <Parts parts={p.parts} {...rest} />
              </sub>
            );
          case "sup":
            return (
              <sup key={i}>
                <Parts parts={p.parts} {...rest} />
              </sup>
            );
          case "br":
            return <br key={i} />;
          case "noteref":
            return (
              <a
                key={i}
                className="md-noteref"
                href={`#nota-${p.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  const target = document.getElementById(`nota-${p.id}`);
                  target?.scrollIntoView({ block: "center", behavior: "smooth" });
                }}
              >
                {p.id}
              </a>
            );
          case "image":
            return (
              <MdImage
                key={i}
                root={rest.root}
                docPath={rest.docPath}
                src={p.src}
                alt={p.alt}
                title={p.title}
                onOpenUrl={rest.onOpenUrl}
              />
            );
          case "link": {
            const external = isExternal(p.href);
            return (
              // No real `href`: a stray click inside the webview would
              // navigate the whole app away. Web addresses open as a portal
              // on the canvas, project paths open as another tab right here.
              <a
                key={i}
                className="md-link"
                role="link"
                tabIndex={0}
                data-tip={p.title ?? p.href}
                onClick={(e) => {
                  e.preventDefault();
                  follow(p.href, rest);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  follow(p.href, rest);
                }}
              >
                <Parts parts={p.parts} {...rest} />
                {external && <ExternalLink size={10} className="md-link-out" />}
              </a>
            );
          }
        }
      })}
    </>
  );
}

function follow(
  href: string,
  { docPath, onOpenPath, onOpenUrl }: Omit<InlineProps, "parts">,
): void {
  if (isExternal(href)) {
    onOpenUrl(href);
    return;
  }
  // `#anchor` alone stays inside the document.
  if (href.startsWith("#")) {
    const slug = href.slice(1).toLowerCase();
    document.getElementById(slug)?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const rel = resolveRelative(docPath, href);
  if (rel) onOpenPath(rel);
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

/**
 * The block's text, colored by the language its fence names.
 *
 * Same grammars, same lazy loading, same token classes as the editor next
 * door: a ```rust block must not read differently on the two sides of the
 * split view. Everything stays React nodes — the no-HTML-injection rule of
 * this file holds for code like for everything else. Until the grammar
 * arrives (one tick, usually), the plain text shows; an unknown language
 * simply stays plain.
 */
function useShine(text: string, lang?: string): ReactNode {
  const [nodes, setNodes] = useState<ReactNode>(null);

  useEffect(() => {
    setNodes(null);
    const desc = lang
      ? LanguageDescription.matchLanguageName(fenceLanguages, lang)
      : null;
    if (!desc) return;
    let alive = true;
    void desc
      .load()
      .then((support) => {
        if (!alive) return;
        setNodes(
          shineLines(text, support).map((chunks, i) => (
            <Fragment key={i}>
              {i > 0 && "\n"}
              {chunkNodes(chunks)}
            </Fragment>
          )),
        );
      })
      .catch(() => {
        // A grammar that fails to load leaves the text plain — never blank.
      });
    return () => {
      alive = false;
    };
  }, [text, lang]);

  return nodes ?? text;
}

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const shine = useShine(text, lang);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span>{lang ? fenceLabel(lang) : ""}</span>
        <button
          className="icon-btn"
          data-tip="Copiar o bloco"
          aria-label="Copiar o bloco de código"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>
        <code>{shine}</code>
      </pre>
    </div>
  );
}

interface BlocksProps extends Omit<InlineProps, "parts"> {
  blocks: Block[];
  onTask: (line: number) => void;
  onGoToLine?: (line: number) => void;
  /** Only the outermost level carries `data-line` anchors for the scroll sync. */
  top?: boolean;
}

function Blocks({ blocks, onTask, onGoToLine, top, ...rest }: BlocksProps) {
  const inner = { ...rest, onTask, onGoToLine };
  return (
    <>
      {blocks.map((b, i) => {
        const anchor = top
          ? {
              "data-line": b.line,
              onDoubleClick: onGoToLine ? () => onGoToLine(b.line) : undefined,
            }
          : {};
        switch (b.t) {
          case "h": {
            const Tag = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[b.level - 1];
            return (
              <Tag key={i} id={b.slug} {...anchor}>
                <Parts parts={b.parts} {...rest} />
              </Tag>
            );
          }
          case "p":
            return (
              <p key={i} {...anchor}>
                <Parts parts={b.parts} {...rest} />
              </p>
            );
          case "code": {
            // Two fences have a rendered face behind their extensions; the
            // blocks gate themselves and fall back to the plain code block.
            const lang = b.lang?.toLowerCase();
            const plain = <CodeBlock text={b.text} lang={b.lang} />;
            return (
              <div key={i} {...anchor}>
                {lang === "mermaid" ? (
                  <MermaidBlock text={b.text} fallback={plain} />
                ) : lang === "math" || lang === "katex" || lang === "latex" ? (
                  <KatexBlock text={b.text} fallback={plain} />
                ) : (
                  plain
                )}
              </div>
            );
          }
          case "quote":
            return (
              <blockquote key={i} {...anchor}>
                <Blocks blocks={b.blocks} {...inner} />
              </blockquote>
            );
          case "hr":
            return <hr key={i} {...anchor} />;
          case "html":
            return (
              <div key={i} className="md-html" {...anchor}>
                <span className="md-html-tag">HTML</span>
                <pre>
                  <code>{b.text}</code>
                </pre>
              </div>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag
                key={i}
                className={`md-list ${b.tight ? "is-tight" : ""} ${
                  b.items.some((it) => it.task) ? "is-tasks" : ""
                }`}
                start={b.ordered && b.start !== 1 ? b.start : undefined}
                {...anchor}
              >
                {b.items.map((item, k) => (
                  <li key={k} className={item.task === "done" ? "is-done" : ""}>
                    {item.task && (
                      <button
                        className="md-check"
                        role="checkbox"
                        aria-checked={item.task === "done"}
                        aria-label={
                          item.task === "done" ? "Reabrir a tarefa" : "Concluir a tarefa"
                        }
                        onClick={() => onTask(item.line)}
                      />
                    )}
                    <Blocks blocks={item.blocks} {...inner} />
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              // The wrapper scrolls, not the page: a wide table must not push
              // the whole document sideways.
              <div key={i} className="md-table-wrap" {...anchor}>
                <table className="md-table">
                  <thead>
                    <tr>
                      {b.head.map((c, k) => (
                        <th key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                          <Parts parts={c.parts} {...rest} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((c, k) => (
                          <td key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                            <Parts parts={c.parts} {...rest} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "note":
            return (
              <div key={i} className="md-note" id={`nota-${b.id}`} {...anchor}>
                <span className="md-note-id">{b.id}</span>
                <div>
                  <Blocks blocks={b.blocks} {...inner} />
                </div>
              </div>
            );
        }
      })}
    </>
  );
}

function MarkdownPreviewImpl({
  text,
  root,
  path,
  onTask,
  onOpenPath,
  onOpenUrl,
  onGoToLine,
}: Props) {
  const blocks = parseDoc(text);
  const title = blocks.find((b) => b.t === "h");

  return (
    <article
      className="md-doc"
      // The document is a reading surface, and the outline needs a label.
      aria-label={title && title.t === "h" ? plain(title.parts) : splitPath(path).base}
    >
      {blocks.length === 0 ? (
        <p className="md-empty">Arquivo vazio — escreva alguma coisa no modo de edição.</p>
      ) : (
        <Blocks
          blocks={blocks}
          root={root}
          docPath={path}
          onTask={onTask}
          onOpenPath={onOpenPath}
          onOpenUrl={onOpenUrl}
          onGoToLine={onGoToLine}
          top
        />
      )}
    </article>
  );
}

/**
 * Memoized: in the split view this re-renders on every keystroke of the pane
 * next door, and re-parsing a 30 KB document per key is exactly the kind of
 * cost that turns a preview into a stutter. Every callback the parent hands
 * over has to be stable for the bail-out to hold.
 */
export const MarkdownPreview = memo(MarkdownPreviewImpl);
