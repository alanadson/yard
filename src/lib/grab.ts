/**
 * Modo Design: pointing at an element in a portal and handing the agent
 * enough to find it in the source.
 *
 * The problem it removes is the translation step. "O botão de salvar está
 * desalinhado" makes the agent grep for a button, guess which one, and ask.
 * A selector, the class list, the box and the computed styles turn the same
 * sentence into an address — and the user never left the page.
 *
 * The script that collects this lives in `portalDriver.ts` (it runs inside
 * the page); everything here is the app's side: validating what came back
 * across the `eval` boundary, and shaping it into the prompt.
 */

export interface GrabPick {
  url: string;
  title: string;
  viewport: { w: number; h: number };
  tag: string;
  id: string;
  classes: string[];
  selector: string;
  /** Label of the parent element, for "which of the six buttons". */
  parent: string;
  text: string;
  attrs: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  html: string;
}

export type GrabResult =
  | { kind: "pending" }
  | { kind: "cancelled" }
  | { kind: "picked"; pick: GrabPick };

function str(value: unknown, max = 400): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function strings(value: unknown, max = 8): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").slice(0, max)
    : [];
}

function record(value: unknown, max = 24): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= max) break;
    if (typeof raw === "string" && raw) out[key] = raw.slice(0, 200);
  }
  return out;
}

function box(value: unknown): { x: number; y: number; w: number; h: number } {
  const v = (value ?? {}) as Record<string, unknown>;
  const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);
  return { x: num(v.x), y: num(v.y), w: num(v.w), h: num(v.h) };
}

/**
 * Reads what the page sent back.
 *
 * Everything is validated because the other side of this boundary is a page
 * the user does not control — `eval` returns whatever a site's own script
 * could have left on `window`, and the app must not crash on it.
 */
export function parseGrab(raw: string): GrabResult {
  const text = raw.trim();
  if (!text) return { kind: "pending" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "cancelled" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "cancelled" };
  const v = parsed as Record<string, unknown>;
  if (v.cancelled === true || typeof v.tag !== "string" || !v.tag) {
    return { kind: "cancelled" };
  }
  const viewport = (v.viewport ?? {}) as Record<string, unknown>;
  return {
    kind: "picked",
    pick: {
      url: str(v.url, 600),
      title: str(v.title, 200),
      viewport: {
        w: typeof viewport.w === "number" ? viewport.w : 0,
        h: typeof viewport.h === "number" ? viewport.h : 0,
      },
      tag: str(v.tag, 40),
      id: str(v.id, 120),
      classes: strings(v.classes),
      selector: str(v.selector, 400),
      parent: str(v.parent, 120),
      text: str(v.text, 300),
      attrs: record(v.attrs),
      rect: box(v.rect),
      styles: record(v.styles),
      html: str(v.html, 1600),
    },
  };
}

/** Backtick-safe inline code — a class list is arbitrary page content. */
function inlineCode(content: string): string {
  let longest = 0;
  let run = 0;
  for (const char of content) {
    if (char !== "`") {
      run = 0;
      continue;
    }
    run += 1;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/** Fence long enough that the page's own backticks cannot close it. */
function fenced(language: string, content: string): string[] {
  let longest = 2;
  let run = 0;
  for (const char of content) {
    if (char !== "`") {
      run = 0;
      continue;
    }
    run += 1;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, content, fence];
}

/** Human name of the element: what the user would call it out loud. */
export function grabLabel(pick: GrabPick): string {
  const name = pick.attrs["aria-label"] || pick.text || pick.attrs.placeholder || "";
  return name ? `${pick.tag} “${name.slice(0, 60)}”` : pick.tag;
}

/**
 * The message the agent receives.
 *
 * Ordered by what an agent needs first: where the page is, which element,
 * how to find it in the source, and only then the styles and the markup.
 *
 * `shot` is the path of a PNG cropped around the element — the same
 * "path in the middle of the prompt" convention the composer uses for a
 * pasted screenshot: the agent opens the file itself.
 */
export function formatGrab(pick: GrabPick, shot?: string | null): string {
  const lines = [
    `Elemento apontado no portal — ${grabLabel(pick)}`,
    "",
    `**Página:** ${pick.url}`,
  ];
  if (shot) {
    lines.push(`**Recorte da tela:** ${inlineCode(shot)} — abra esta imagem para ver o elemento.`);
  }
  lines.push(`**Seletor:** ${inlineCode(pick.selector || pick.tag)}`);

  if (pick.classes.length) {
    lines.push(`**Classes:** ${inlineCode(pick.classes.join(" "))}`);
  }
  if (pick.parent) lines.push(`**Dentro de:** ${inlineCode(pick.parent)}`);
  if (pick.text) lines.push(`**Texto:** “${pick.text}”`);

  const attrs = Object.entries(pick.attrs).filter(([k]) => k !== "aria-label");
  if (attrs.length) {
    lines.push(
      `**Atributos:** ${attrs.map(([k, v]) => `${k}=${inlineCode(v)}`).join(", ")}`,
    );
  }

  lines.push(
    `**Caixa:** ${pick.rect.w}×${pick.rect.h} em (${pick.rect.x}, ${pick.rect.y})` +
      (pick.viewport.w ? ` · viewport ${pick.viewport.w}×${pick.viewport.h}` : ""),
  );

  const styles = Object.entries(pick.styles);
  if (styles.length) {
    lines.push("**Estilo calculado:**");
    for (const [key, value] of styles) lines.push(`- ${kebab(key)}: ${value}`);
  }

  if (pick.html) {
    lines.push("**HTML:**");
    lines.push(...fenced("html", pick.html));
  }

  lines.push("", "O que muda aqui: ");
  return lines.join("\n");
}

/** `backgroundColor` is what the DOM calls it; CSS calls it `background-color`. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
