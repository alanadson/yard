/**
 * The built-in extension catalog — the "store" shelf.
 *
 * An extension here is not downloaded code: it is a feature that already ships
 * with the Yard, packaged with a name and a description so it can be turned on
 * and off from one place (the Extensões modal). What each one *does* lives in
 * the component it touches; this file only answers "what exists and how it
 * presents itself". The union and the list are one thing, like `MARKS`:
 * adding an entry here is what makes the id exist for the store and the modal.
 */
import { SCHEMES } from "./colorSchemes";

export type ExtensionId =
  | "symbols"
  | "material-icons"
  | "code-fonts"
  | "rainbow-brackets"
  | "todo-highlight"
  | "minimap"
  | "indent-guides"
  | "css-colors"
  | "format-on-save"
  | "term-images"
  | "mermaid"
  | "katex"
  | "theme-dracula"
  | "theme-nord"
  | "theme-catppuccin"
  | "theme-tokyo-night"
  | "theme-rose-pine"
  | "theme-solarized"
  | "theme-one-dark"
  | "theme-ayu"
  | "theme-github-dark";

/** Where the extension acts — the shelf's sections and the store's filter. */
export type ExtensionKind = "icons" | "themes" | "fonts" | "editor" | "terminal" | "markdown";

/** Section order of the shelf; `chip` is the short scope-bar label. */
export const EXTENSION_KINDS: readonly { id: ExtensionKind; chip: string; label: string }[] = [
  { id: "icons", chip: "Ícones", label: "Ícones de arquivo" },
  { id: "themes", chip: "Temas", label: "Temas de cor" },
  { id: "fonts", chip: "Fontes", label: "Fontes" },
  { id: "editor", chip: "Editor", label: "Editor" },
  { id: "terminal", chip: "Terminal", label: "Terminal" },
  { id: "markdown", chip: "Markdown", label: "Markdown" },
];

export interface ExtensionDef {
  id: ExtensionId;
  name: string;
  author: string;
  /** Upstream version when the extension is vendored third-party work. */
  version: string;
  /** License shown beside the author — credit belongs on the shelf. */
  license: string;
  /**
   * Extensions in the same category exclude each other: two icon themes (or
   * two color schemes) at once would claim the same surface. Turning one on
   * turns its siblings off. Absent = independent switch.
   */
  category?: "icon-theme" | "color-theme";
  /** Which shelf section (and store filter) the card belongs to. */
  kind: ExtensionKind;
  /** One line under the name, like a store listing. */
  description: string;
  /** What actually changes in the app while it is on. */
  details: string;
}

/** Who is credited on each color-scheme card. All the palettes are MIT. */
const SCHEME_AUTHORS: Record<string, string> = {
  "theme-dracula": "Zeno Rocha e contribuidores",
  "theme-nord": "Sven Greb (Nord Project)",
  "theme-catppuccin": "Catppuccin Org",
  "theme-tokyo-night": "enkia",
  "theme-rose-pine": "Rosé Pine Org",
  "theme-solarized": "Ethan Schoonover",
  "theme-one-dark": "Atom (GitHub)",
  "theme-ayu": "Ike Ku (dempfi)",
  "theme-github-dark": "GitHub (Primer)",
};

const SCHEME_CARDS: ExtensionDef[] = SCHEMES.map((s) => ({
  id: s.id as ExtensionId,
  name: s.name,
  author: SCHEME_AUTHORS[s.id] ?? "—",
  version: "1.0.0",
  license: "MIT",
  category: "color-theme" as const,
  kind: "themes" as const,
  description: "Tema de cor para o terminal e a sintaxe do editor",
  details:
    "Recolore o conteúdo — os 16 tons ANSI, fundo e cursor dos terminais, e " +
    "as cores de sintaxe do editor e dos diffs de código. O cromo do Yard " +
    "continua o mesmo: tema é cor de conteúdo, não de moldura. Só um tema de " +
    "cor fica ativo por vez; desligar todos volta à paleta padrão do Yard.",
}));

export const EXTENSIONS: readonly ExtensionDef[] = [
  {
    id: "symbols",
    name: "Symbols",
    author: "Miguel Solorio",
    version: "0.0.25",
    license: "MIT",
    category: "icon-theme",
    kind: "icons",
    description: "O tema de ícones de arquivo Symbols, o mesmo do VS Code",
    details:
      "Os ícones originais do tema Symbols (miguelsolorio/vscode-symbols), " +
      "embutidos no Yard: árvore de arquivos, Busca e abas passam a usar os " +
      "SVGs e o mapeamento oficiais — mais de 350 ícones, com pastas " +
      "nomeadas (src, docs, node_modules…). Desligada, a árvore volta ao " +
      "contrato original: só o git colore.",
  },
  {
    id: "material-icons",
    name: "Material Icon Theme",
    author: "Philipp Kief",
    version: "5.37.0",
    license: "MIT",
    category: "icon-theme",
    kind: "icons",
    description: "O tema de ícones mais usado do VS Code, o oficial",
    details:
      "Os ícones originais do Material Icon Theme (PKief/vscode-material-" +
      "icon-theme): 1250 ícones e o mapeamento oficial completo — milhares " +
      "de nomes de arquivo e de pasta, com variante de pasta aberta. Só um " +
      "tema de ícones fica ativo por vez.",
  },
  ...SCHEME_CARDS,
  {
    id: "code-fonts",
    name: "Fontes de código",
    author: "JetBrains, Mozilla, GitHub, IBM e outros",
    version: "2.0.0",
    license: "OFL 1.1",
    kind: "fonts",
    description: "Dez famílias monoespaçadas embutidas, a maioria com ligaduras",
    details:
      "JetBrains Mono, Fira Code, Victor Mono, IBM Plex Mono, Monaspace " +
      "Neon, Iosevka, Source Code Pro, Commit Mono, Geist Mono e Intel One " +
      "Mono empacotadas no Yard (via Fontsource) — aparecem nos seletores " +
      "das Preferências sem instalar nada no Windows, e valem para o " +
      "terminal, o editor e os diffs.",
  },
  {
    id: "rainbow-brackets",
    name: "Parênteses arco-íris",
    author: "Yard",
    version: "1.0.0",
    license: "Apache-2.0",
    kind: "editor",
    description: "Cada nível de ( ) [ ] { } numa cor, no editor de código",
    details:
      "Colore os pares pela profundidade do aninhamento, em cinco cores que " +
      "se repetem — o par em volta do cursor continua com o realce azul de " +
      "sempre. Usa a gramática do arquivo: colchete dentro de string ou " +
      "comentário não conta.",
  },
  {
    id: "todo-highlight",
    name: "Realce de TODO",
    author: "Yard",
    version: "1.0.0",
    license: "Apache-2.0",
    kind: "editor",
    description: "TODO, FIXME, HACK e NOTE saltam aos olhos no editor",
    details:
      "Marca as palavras de pendência no texto do arquivo: TODO em âmbar, " +
      "FIXME e BUG em vermelho, HACK e XXX em laranja, NOTE em azul — cada " +
      "uma como uma pequena etiqueta, fácil de varrer ao rolar o arquivo.",
  },
  {
    id: "minimap",
    name: "Minimapa",
    author: "Replit",
    version: "0.5.x",
    license: "MIT",
    kind: "editor",
    description: "O arquivo inteiro em miniatura, na borda direita do editor",
    details:
      "A visão de pássaro clássica das IDEs: blocos de texto em miniatura " +
      "com a janela visível marcada, para navegar arquivo grande arrastando. " +
      "Extensão @replit/codemirror-minimap, embutida.",
  },
  {
    id: "indent-guides",
    name: "Guias de indentação",
    author: "Replit",
    version: "6.5.x",
    license: "MIT",
    kind: "editor",
    description: "Linhas verticais marcando cada nível de recuo no editor",
    details:
      "Desenha as guias que mostram onde cada bloco começa e termina, com o " +
      "bloco ativo destacado — a mesma heurística do Monaco e do Ace. " +
      "Extensão @replit/codemirror-indentation-markers, embutida.",
  },
  {
    id: "css-colors",
    name: "Cores no CSS",
    author: "Replit",
    version: "1.3.x",
    license: "MIT",
    kind: "editor",
    description: "Um seletor de cor ao lado de cada #hex e rgb() no código",
    details:
      "Todo valor de cor num arquivo CSS/SCSS ganha um quadradinho com a " +
      "cor real, clicável para trocar pelo seletor do sistema. Extensão " +
      "@replit/codemirror-css-color-picker, embutida.",
  },
  {
    id: "format-on-save",
    name: "Formatar ao salvar",
    author: "Prettier",
    version: "3.x",
    license: "MIT",
    kind: "editor",
    description: "Ctrl+S formata o arquivo com o Prettier antes de gravar",
    details:
      "JS, TS, JSX, JSON, CSS, SCSS, HTML, Markdown e YAML passam pelo " +
      "Prettier embutido no salvamento — o cursor fica onde estava e o undo " +
      "desfaz a formatação como qualquer edição. Arquivo com erro de sintaxe " +
      "é salvo como está, sem bloquear.",
  },
  {
    id: "term-images",
    name: "Imagens no terminal",
    author: "The xterm.js authors",
    version: "0.8.x",
    license: "MIT",
    kind: "terminal",
    description: "Protocolos sixel e iTerm desenham imagens no scrollback",
    details:
      "CLIs que emitem imagens (gráficos de ferramentas, previews, o " +
      "timg/chafa da vida) passam a desenhá-las de verdade dentro do " +
      "terminal. Addon oficial @xterm/addon-image, embutido.",
  },
  {
    id: "mermaid",
    name: "Diagramas Mermaid",
    author: "Mermaid (Knut Sveidqvist e contribuidores)",
    version: "11.x",
    license: "MIT",
    kind: "markdown",
    description: "Blocos ```mermaid viram diagramas de verdade no markdown",
    details:
      "Fluxogramas, sequências e afins que os agentes escrevem em markdown " +
      "são renderizados na leitura e no modo dividido do editor — com " +
      "sanitização estrita e o texto original a um clique. Bloco com erro de " +
      "sintaxe continua aparecendo como código.",
  },
  {
    id: "katex",
    name: "Fórmulas KaTeX",
    author: "KaTeX (Khan Academy e contribuidores)",
    version: "0.16.x",
    license: "MIT",
    kind: "markdown",
    description: "Blocos ```math viram fórmulas renderizadas no markdown",
    details:
      "Notação TeX em blocos ```math (ou ```katex) é desenhada como fórmula " +
      "na leitura e no modo dividido. Fórmula com erro mostra o texto " +
      "original, nunca uma tela quebrada.",
  },
];

/**
 * The extensions the Extensions category in Settings lists.
 *
 * Everything but the color themes. There each row is name + sentence +
 * switch, and a switch promises independence: the themes take turns (turning
 * one on turns its sibling off, which may be off screen) and are chosen by
 * palette, not by name. They stay in the full store, with radio and preview.
 */
export function settingsExtensions(): ExtensionDef[] {
  return EXTENSIONS.filter((e) => e.kind !== "themes");
}

/**
 * Which control the extension asks for in a list.
 *
 * A switch promises independence; whoever has a `category` takes turns with
 * its siblings, and the card that turns itself off may be far away, off
 * screen. A radio tells the truth about the rule — clicking the one already
 * on turns it off (no theme is a valid choice too). The store already did it
 * this way; the rule left its JSX to apply in both places.
 */
export function extensionControl(ext: ExtensionDef): "radio" | "switch" {
  return ext.category ? "radio" : "switch";
}
