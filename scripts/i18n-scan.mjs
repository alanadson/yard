#!/usr/bin/env node
/**
 * Lists user-visible Portuguese strings that are not yet wrapped in `t()` /
 * `tn()`, grouped by the areas of `src/i18n/en/`.
 *
 *   node scripts/i18n-scan.mjs             # every candidate, then totals
 *   node scripts/i18n-scan.mjs --area shell
 *   node scripts/i18n-scan.mjs --summary   # totals only
 *
 * Heuristic on purpose: a false positive costs a glance, a false negative
 * costs an English user a Portuguese label. It looks at JSX text nodes and
 * at string/template literals that carry an accent or a common Portuguese
 * word, in the attributes and calls where copy lives (`title`, `aria-label`,
 * `placeholder`, `data-tip`, `label`, `desc`, `hint`, `showToast(`, `ask(`,
 * `confirm(`, `label:`, `title:`, `subtitle:`, `desc:`…). It skips tests,
 * `src/i18n/`, log/console lines, comments, imports, ids, kv keys, CSS
 * classes and `<kbd>`/`<code>` contents. Two markers silence it on purpose:
 * a `// i18n-ok` at the end of a line (a language name, a brand), and a
 * `// i18n-scan: tables` anywhere in a file whose strings are tables rendered
 * through `t()` somewhere else (shortcuts, settings categories).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/**
 * Area → the paths (relative to `src/`, forward slashes) it owns. Order
 * matters: the first match wins, and `lib` is the catch-all for whatever
 * in `lib/`, `stores/` and `hooks/` no other area claimed.
 */
export const AREAS = [
  [
    "shell",
    [
      "App.tsx",
      "main.tsx",
      "components/TitleBar/",
      "components/ProjectSidebar/",
      "components/TerminalPane/",
      "components/XTermView/",
      "components/WorkspaceGrid/",
      "components/BrowserPane/",
      "components/StatusBar/",
      "components/ErrorBoundary/",
      "components/ExitBanner/",
      "components/ContextMenu/",
      "components/Select/",
      "components/NumberField/",
      "components/Resizer/",
      "components/BrandIcon/",
      "components/FileGlyph/",
      "components/FileMarks/",
    ],
  ],
  [
    "canvas",
    [
      "components/CanvasView/",
      "components/Floors/",
      "components/Overlay/",
      "lib/canvas",
      "lib/floor",
      "lib/flow",
      "lib/arrange.ts",
      "lib/boards.ts",
      "lib/binder.ts",
      "lib/dropPoint.ts",
      "lib/mediaNode.ts",
      "lib/gitGraph.ts",
      "lib/portal",
      "lib/scores.ts",
      "lib/wobble.ts",
      "lib/layers.ts",
      "lib/triggers.ts",
      "lib/roles.ts",
      "lib/roleBrief.ts",
    ],
  ],
  ["modals", ["components/modals/"]],
  ["settings", ["components/Settings/"]],
  [
    "bench",
    [
      "components/BenchPanel/",
      "components/ChangesPanel/",
      "components/DiffViewer/",
      "components/FileTree/",
      "lib/scm",
      "lib/bench",
      "lib/changes",
      "lib/commitBox.ts",
      "lib/review.ts",
      "lib/fileTreeMenu.tsx",
      "lib/diff.ts",
      "lib/lineDiff.ts",
      "lib/treeNode.ts",
    ],
  ],
  [
    "editor",
    [
      "components/CodeEditor/",
      "lib/mddoc.ts",
      "lib/mdedit.ts",
      "lib/markdown.ts",
      "lib/editorActions.ts",
      "lib/editorTabMenu.ts",
      "lib/symbols.ts",
      "lib/diffTab.ts",
      "lib/lsp/",
      "lib/media.ts",
    ],
  ],
  [
    "notes",
    [
      "components/NotesView/",
      "components/LiveView/",
      "components/Composer/",
      "components/Palette/",
      "lib/notes",
      "lib/search.ts",
      "lib/attention.ts",
      "lib/shoulder.ts",
      "lib/transcript",
      "lib/sessionFind.ts",
    ],
  ],
  ["stores", ["stores/", "hooks/"]],
  ["lib", ["lib/"]],
];

const PT_WORDS =
  /\b(não|você|arquivo|arquivos|grupo|grupos|projeto|projetos|agente|agentes|terminal|terminais|nova|novo|salvar|fechar|abrir|copiar|excluir|mostrar|esconder|nenhum|nenhuma|falha|erro|pronto|agora|sessão|sessões|painel|aba|abas|nota|notas|andar|andares|criar|remover|apagar|rodando|parado|esperando|carregando|procurar|buscar|enviar|prompt|tarefa|tarefas|caminho|pasta|selecionar|todos|todas|último|última|próximo|próxima|anterior)\b/i;
const ACCENT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;
const SKIP_LINE = /\b(uiLog|console|tracing)\.|^\s*(\/\/|\*|\/\*)|^\s*import\b|\bfrom\s+["']|\binvoke\s*\(|\blisten\s*\(|\bpersistPref\s*\(|\bpersistJsonPref\s*\(|\bkv\b|\bclassName\s*=|\bclass\s*:|data-tip-at|\bid\s*:\s*["'`]|\bkind\s*:\s*["'`]|\bkey\s*=\s*["'`]|\bhref\s*=|\brole\s*=\s*["']|\baria-hidden|\btype\s*=\s*["']/;
const NO_TAG = /<(kbd|code|pre|samp|style|script)\b[^>]*>[^<]*$/;

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "i18n") continue;
      listFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      // The `yard` CLI's own output (`lib/bridge*.ts`) is read by agents, not
      // by the user — out of scope by design.
      if (/^bridge\w*\.ts$/.test(name) && /[\\/]lib$/.test(dir)) continue;
      out.push(full);
    }
  }
  return out;
}

export function areaOf(rel) {
  for (const [area, prefixes] of AREAS) {
    if (prefixes.some((p) => rel.startsWith(p))) return area;
  }
  return "other";
}

function looksPortuguese(text) {
  return ACCENT.test(text) || PT_WORDS.test(text);
}

/** `true` when the literal that starts at `index` sits inside a `t(` / `tn(` call. */
function wrapped(line, index) {
  const before = line.slice(0, index);
  return /\bt\(\s*$/.test(before) || /\btn\([^)]*$/.test(before);
}

const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
const JSX_TEXT = />([^<>{}]*\p{L}[^<>{}]*)</gu;

/** A bare lowercase token with no space or accent is an id, an enum, a kv key. */
function looksLikeId(value) {
  return /^[a-z0-9_.:/-]+$/.test(value);
}

export function scanText(text, { jsx = true } = {}) {
  const hits = [];
  if (/i18n-scan:\s*tables/.test(text)) return hits;
  const lines = text.split(/\r?\n/);
  // A `t(` that ends a line wraps the literal on the next one.
  let pendingWrap = false;
  lines.forEach((line, i) => {
    const wrapsNext = /\bt(?:n)?\(\s*$/.test(line) || /\btn\([^)]*,\s*$/.test(line);
    const wrappedByPrevious = pendingWrap;
    pendingWrap = wrapsNext;
    if (SKIP_LINE.test(line) || /\/\/\s*i18n-ok\b/.test(line)) return;
    let m;
    // Only a .tsx file has JSX text nodes; in a .ts file the same shape is a
    // type argument (`=> Promise<Foo>`), which is never a sentence.
    JSX_TEXT.lastIndex = 0;
    while (jsx && (m = JSX_TEXT.exec(line))) {
      const inner = m[1].trim();
      if (!inner || !/\p{L}{2,}/u.test(inner)) continue;
      if (NO_TAG.test(line.slice(0, m.index + 1))) continue;
      hits.push({ line: i + 1, text: inner, kind: "jsx" });
    }
    LITERAL.lastIndex = 0;
    while ((m = LITERAL.exec(line))) {
      const value = m[1] ?? m[2] ?? m[3] ?? "";
      if (!/\p{L}{2,}/u.test(value) || !looksPortuguese(value)) continue;
      if (looksLikeId(value)) continue;
      if (wrapped(line, m.index) || (wrappedByPrevious && m.index === line.search(/\S/))) continue;
      hits.push({ line: i + 1, text: value, kind: "literal" });
    }
  });
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const areaFilter = args.includes("--area") ? args[args.indexOf("--area") + 1] : null;
  const summary = args.includes("--summary");
  const totals = new Map();
  let shown = 0;
  for (const file of listFiles(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    const area = areaOf(rel);
    if (areaFilter && area !== areaFilter) continue;
    const hits = scanText(readFileSync(file, "utf8"), { jsx: file.endsWith(".tsx") });
    if (!hits.length) continue;
    totals.set(area, (totals.get(area) ?? 0) + hits.length);
    if (summary) continue;
    for (const h of hits) {
      console.log(`${rel}:${h.line}: ${JSON.stringify(h.text)}`);
      shown++;
    }
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  console.log(shown ? "" : "", "--- candidates per area ---");
  for (const [area, n] of sorted) console.log(`${area.padEnd(10)} ${n}`);
  console.log(`${"total".padEnd(10)} ${[...totals.values()].reduce((a, b) => a + b, 0)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
