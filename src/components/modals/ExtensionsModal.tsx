/**
 * Extensões — the store shelf.
 *
 * Looks like a marketplace, works like a switchboard: everything on it already
 * ships with the Yard, so "install" is just turning it on. Each card shows
 * what the extension changes — with a live preview drawn by the extension
 * itself where that is possible — and one button that flips it. The switch
 * takes effect immediately app-wide; nothing here needs a restart.
 *
 * The icon-theme previews come through `lazy()` like the tree does: the two
 * vendored themes are ~1MB of maps together, and opening the shelf should not
 * pay for both up front. Color-scheme cards draw straight from the palette
 * table (`lib/colorSchemes.ts`) — data, not screenshots.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Blocks, PackageSearch, Search, X } from "lucide-react";

import { Modal } from "./Modal";
import { logoOf, SchemePreview } from "./extLogos";
import { BUNDLED_FONTS, loadBundledFonts } from "../../lib/bundledFonts";
import { schemeFor } from "../../lib/colorSchemes";
import {
  extensionControl,
  EXTENSION_KINDS,
  EXTENSIONS,
  type ExtensionDef,
  type ExtensionId,
  type ExtensionKind,
} from "../../lib/extensions";
import { useExtensions } from "../../stores/extensionsStore";
import { useUI } from "../../stores/uiStore";

const SymbolIcon = lazy(() => import("../FileGlyph/symbols"));
const MaterialIcon = lazy(() => import("../FileGlyph/material"));

/** The sample the two icon themes draw — names this repo would show. */
const PREVIEW_DIRS = ["src", "docs", "node_modules"];
const PREVIEW_FILES = ["App.tsx", "styles.css", "package.json", "main.rs", "README.md"];

// ---------------------------------------------------------------------------
// previews
// ---------------------------------------------------------------------------

/** Sample line per bundled family, drawn in the family itself once it loads. */
function FontsPreview() {
  useEffect(() => {
    void loadBundledFonts().catch(() => {});
  }, []);
  return (
    <div className="ext-preview" aria-hidden="true">
      {BUNDLED_FONTS.map((f) => (
        <span
          key={f.family}
          className="ext-preview-item"
          style={{ fontFamily: `"${f.family}", Consolas, monospace` }}
        >
          {f.family} · {"=> != >= ::"}
        </span>
      ))}
    </div>
  );
}

function chip(label: string, bg: string, color: string) {
  return (
    <span key={label} className="ext-chip" style={{ background: bg, color }}>
      {label}
    </span>
  );
}

function previewOf(ext: ExtensionDef) {
  const scheme = schemeFor(ext.id);
  if (scheme) return <SchemePreview scheme={scheme} />;
  switch (ext.id) {
    case "symbols":
    case "material-icons": {
      const Icon = ext.id === "symbols" ? SymbolIcon : MaterialIcon;
      return (
        <div className="ext-preview" aria-hidden="true">
          <Suspense fallback={null}>
            {PREVIEW_DIRS.map((n) => (
              <span key={n} className="ext-preview-item">
                <Icon name={n} dir size={14} />
                {n}
              </span>
            ))}
            {PREVIEW_FILES.map((n) => (
              <span key={n} className="ext-preview-item">
                <Icon name={n} size={14} />
                {n}
              </span>
            ))}
          </Suspense>
        </div>
      );
    }
    case "code-fonts":
      return <FontsPreview />;
    case "rainbow-brackets":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">
            fn<span style={{ color: "#e3b341" }}>(</span>a
            <span style={{ color: "#f778ba" }}>[</span>b
            <span style={{ color: "#79c0ff" }}>{"{"}</span>c
            <span style={{ color: "#79c0ff" }}>{"}"}</span>
            <span style={{ color: "#f778ba" }}>]</span>
            <span style={{ color: "#e3b341" }}>)</span>
          </span>
        </div>
      );
    case "todo-highlight":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">
            {chip("TODO", "rgb(227 179 65 / 22%)", "#e3b341")}
            {chip("FIXME", "rgb(248 81 73 / 20%)", "#f85149")}
            {chip("HACK", "rgb(240 136 62 / 20%)", "#f0883e")}
            {chip("NOTE", "rgb(121 192 255 / 18%)", "#79c0ff")}
          </span>
        </div>
      );
    case "css-colors":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">
            color: <span className="ext-swatch" style={{ background: "#0a84ff" }} />
            #0a84ff; · background:{" "}
            <span className="ext-swatch" style={{ background: "#7ee787" }} /> #7ee787;
          </span>
        </div>
      );
    case "format-on-save":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">
            <s style={{ opacity: 0.6 }}>{"const x={a:1,b:2}"}</s>
            <span style={{ color: "#7ee787" }}>→</span>
            {"const x = { a: 1, b: 2 };"}
          </span>
        </div>
      );
    case "mermaid":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">```mermaid</span>
          <span className="ext-preview-item">{"graph LR; A-->B; A-->C"}</span>
          <span className="ext-preview-item" style={{ color: "#7ee787" }}>
            → diagrama desenhado na leitura
          </span>
        </div>
      );
    case "katex":
      return (
        <div className="ext-preview" aria-hidden="true">
          <span className="ext-preview-item">```math</span>
          <span className="ext-preview-item">{"e^{i\\pi} + 1 = 0"}</span>
          <span className="ext-preview-item" style={{ color: "#d2a8ff" }}>
            → fórmula desenhada na leitura
          </span>
        </div>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// the shelf
// ---------------------------------------------------------------------------

function ExtensionCard({ ext }: { ext: ExtensionDef }) {
  const on = useExtensions((s) => s.enabled[ext.id] === true);
  const setEnabled = useExtensions((s) => s.setEnabled);
  const radio = extensionControl(ext) === "radio";

  return (
    <article className={`ext-card ${on ? "is-on" : ""}`}>
      <div className="ext-logo" aria-hidden="true">
        {logoOf(ext)}
      </div>
      <div className="ext-info">
        <div className="ext-name-row">
          <span className="ext-name">{ext.name}</span>
          <span className="ext-meta">
            {ext.author} · v{ext.version} · {ext.license}
          </span>
        </div>
        <p className="ext-desc">{ext.description}</p>
        <p className="ext-details">{ext.details}</p>
        {previewOf(ext)}
      </div>
      <div className="ext-actions">
        {/* Themes take turns: turning one on turns its sibling off. A toggle
            promised independence and lied — the card being switched off could
            be far away, off screen. A radio tells the truth of the rule;
            clicking the one already on turns it off (no theme at all is a
            valid choice too). */}
        <input
          type={radio ? "radio" : "checkbox"}
          role={radio ? undefined : "switch"}
          name={ext.category}
          className={radio ? "ext-radio" : "switch"}
          checked={on}
          onChange={() => setEnabled(ext.id as ExtensionId, true)}
          onClick={() => {
            if (ext.category && on) setEnabled(ext.id as ExtensionId, false);
          }}
          aria-label={ext.name}
        />
      </div>
    </article>
  );
}

/** Accent-insensitive: "icones" finds "Ícones", "formulas" finds "Fórmulas". */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function ExtensionsModal() {
  const closeModal = useUI((s) => s.closeModal);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ExtensionKind | "all">("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const sections = useMemo(() => {
    const q = fold(query.trim());
    const hit = (ext: ExtensionDef) => {
      if (q === "") return true;
      const label = EXTENSION_KINDS.find((k) => k.id === ext.kind)?.label ?? "";
      return fold(
        `${ext.name} ${ext.author} ${ext.description} ${ext.details} ${label}`,
      ).includes(q);
    };
    return EXTENSION_KINDS.filter((k) => kind === "all" || k.id === kind)
      .map((k) => ({ ...k, items: EXTENSIONS.filter((e) => e.kind === k.id && hit(e)) }))
      .filter((k) => k.items.length > 0);
  }, [query, kind]);

  const total = sections.reduce((n, s) => n + s.items.length, 0);

  const clearAll = () => {
    setQuery("");
    setKind("all");
    inputRef.current?.focus();
  };

  return (
    <Modal
      title="Extensões"
      onClose={closeModal}
      wide
      initialFocus=".ext-search input"
      headerExtra={
        <div className="bench-search ext-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar extensões"
            aria-label="Buscar extensões"
            onKeyDown={(e) => {
              // First Esc empties the search; only an empty one lets the
              // modal's own Esc close the sheet.
              if (e.key === "Escape" && query !== "") {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query !== "" && (
            <button
              className="icon-btn"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Limpar busca"
            >
              <X size={12} />
            </button>
          )}
        </div>
      }
      toolbar={
        <div className="ext-scopes" role="group" aria-label="Filtrar por categoria">
          <button
            className={`ext-scope ${kind === "all" ? "is-active" : ""}`}
            aria-pressed={kind === "all"}
            onClick={() => setKind("all")}
          >
            Todas
          </button>
          {EXTENSION_KINDS.map((k) => (
            <button
              key={k.id}
              className={`ext-scope ${kind === k.id ? "is-active" : ""}`}
              aria-pressed={kind === k.id}
              onClick={() => setKind(kind === k.id ? "all" : k.id)}
            >
              {k.chip}
            </button>
          ))}
        </div>
      }
    >
      <div className="ext-shelf">
        {kind === "all" && query === "" && (
          <p className="hint" style={{ margin: "0 0 12px" }}>
            <Blocks size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Recursos que já vêm com o Yard, desligados até você querer. O
            interruptor vale na hora, para o aplicativo inteiro — temas (de
            ícones ou de cor) se revezam: ligar um desliga o irmão.
          </p>
        )}
        {sections.map((s) => (
          <section className="ext-section" key={s.id}>
            <h4 className="ext-section-h">
              {s.label}
              <span className="ext-section-n">{s.items.length}</span>
              {/* The rule stated in the section itself, not only in the top
                  paragraph that vanishes as soon as someone filters. */}
              {s.items.some((e) => e.category) && (
                <span className="ext-section-rule">um de cada vez</span>
              )}
            </h4>
            {s.items.map((ext) => (
              <ExtensionCard key={ext.id} ext={ext} />
            ))}
          </section>
        ))}
        {total === 0 && (
          <div className="ext-empty">
            <PackageSearch size={26} aria-hidden="true" />
            <p>
              Nenhuma extensão para <strong>“{query.trim()}”</strong>
              {kind !== "all" ? " nesta categoria" : ""}.
            </p>
            <button className="btn btn--sm" onClick={clearAll}>
              Limpar busca
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
