/**
 * The color schemes the store ships — pure data, no CodeMirror or xterm
 * imports, so both sides (and the store cards) read from one table.
 *
 * Each scheme carries the two surfaces it recolors:
 * - `term`: a full xterm theme (background included — terminals are content
 *   wells, the ground around them stays the Yard's);
 * - `syntax`: the handful of roles the editor's highlight uses. The editor
 *   keeps its own background and chrome: per the visual contract, a scheme
 *   colors *content*, never the frame.
 *
 * Palettes transcribed from each project's published specification; the
 * authors and licenses are credited on the store cards (all MIT).
 */

export interface TermPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface SyntaxPalette {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  type: string;
  property: string;
  tag: string;
  operator: string;
  variable: string;
}

export interface ColorScheme {
  /** The extension id that turns this scheme on (see `lib/extensions.ts`). */
  id: string;
  name: string;
  term: TermPalette;
  syntax: SyntaxPalette;
}

/** Fills the bright row from the normal one when a spec leaves them equal. */
function ansi(
  base: Omit<TermPalette, `bright${string}`> & Partial<TermPalette>,
): TermPalette {
  return {
    brightBlack: base.black,
    brightRed: base.red,
    brightGreen: base.green,
    brightYellow: base.yellow,
    brightBlue: base.blue,
    brightMagenta: base.magenta,
    brightCyan: base.cyan,
    brightWhite: base.white,
    ...base,
  };
}

export const SCHEMES: readonly ColorScheme[] = [
  {
    id: "theme-dracula",
    name: "Dracula",
    term: ansi({
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    }),
    syntax: {
      keyword: "#ff79c6",
      string: "#f1fa8c",
      number: "#bd93f9",
      comment: "#6272a4",
      function: "#50fa7b",
      type: "#8be9fd",
      property: "#66d9ef",
      tag: "#ff79c6",
      operator: "#ff79c6",
      variable: "#f8f8f2",
    },
  },
  {
    id: "theme-nord",
    name: "Nord",
    term: ansi({
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    }),
    syntax: {
      keyword: "#81a1c1",
      string: "#a3be8c",
      number: "#b48ead",
      comment: "#616e88",
      function: "#88c0d0",
      type: "#8fbcbb",
      property: "#d8dee9",
      tag: "#81a1c1",
      operator: "#81a1c1",
      variable: "#d8dee9",
    },
  },
  {
    id: "theme-catppuccin",
    name: "Catppuccin Mocha",
    term: ansi({
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightWhite: "#a6adc8",
    }),
    syntax: {
      keyword: "#cba6f7",
      string: "#a6e3a1",
      number: "#fab387",
      comment: "#7f849c",
      function: "#89b4fa",
      type: "#f9e2af",
      property: "#89dceb",
      tag: "#cba6f7",
      operator: "#94e2d5",
      variable: "#cdd6f4",
    },
  },
  {
    id: "theme-tokyo-night",
    name: "Tokyo Night",
    term: ansi({
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightWhite: "#c0caf5",
    }),
    syntax: {
      keyword: "#bb9af7",
      string: "#9ece6a",
      number: "#ff9e64",
      comment: "#565f89",
      function: "#7aa2f7",
      type: "#2ac3de",
      property: "#73daca",
      tag: "#f7768e",
      operator: "#89ddff",
      variable: "#c0caf5",
    },
  },
  {
    id: "theme-rose-pine",
    name: "Rosé Pine", // i18n-ok
    term: ansi({
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#e0def4",
      cursorAccent: "#191724",
      selectionBackground: "#403d52",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
    }),
    syntax: {
      keyword: "#31748f",
      string: "#f6c177",
      number: "#eb6f92",
      comment: "#6e6a86",
      function: "#ebbcba",
      type: "#9ccfd8",
      property: "#c4a7e7",
      tag: "#eb6f92",
      operator: "#908caa",
      variable: "#e0def4",
    },
  },
  {
    id: "theme-solarized",
    name: "Solarized Dark",
    term: ansi({
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    }),
    syntax: {
      keyword: "#859900",
      string: "#2aa198",
      number: "#d33682",
      comment: "#586e75",
      function: "#268bd2",
      type: "#b58900",
      property: "#839496",
      tag: "#268bd2",
      operator: "#859900",
      variable: "#839496",
    },
  },
  {
    id: "theme-one-dark",
    name: "One Dark",
    term: ansi({
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
    }),
    syntax: {
      keyword: "#c678dd",
      string: "#98c379",
      number: "#d19a66",
      comment: "#5c6370",
      function: "#61afef",
      type: "#e5c07b",
      property: "#e06c75",
      tag: "#e06c75",
      operator: "#56b6c2",
      variable: "#abb2bf",
    },
  },
  {
    id: "theme-ayu",
    name: "Ayu Dark",
    term: ansi({
      background: "#0b0e14",
      foreground: "#bfbdb6",
      cursor: "#e6b450",
      cursorAccent: "#0b0e14",
      selectionBackground: "#409fff44",
      black: "#1d242c",
      red: "#ea6c73",
      green: "#91b362",
      yellow: "#f9af4f",
      blue: "#53bdfa",
      magenta: "#fae994",
      cyan: "#90e1c6",
      white: "#c7c7c7",
      brightBlack: "#686868",
      brightRed: "#f07178",
      brightGreen: "#c2d94c",
      brightYellow: "#ffb454",
      brightBlue: "#59c2ff",
      brightMagenta: "#ffee99",
      brightCyan: "#95e6cb",
      brightWhite: "#ffffff",
    }),
    syntax: {
      keyword: "#ff8f40",
      string: "#aad94c",
      number: "#d2a6ff",
      comment: "#626a73",
      function: "#ffb454",
      type: "#59c2ff",
      property: "#bfbdb6",
      tag: "#39bae6",
      operator: "#f29668",
      variable: "#bfbdb6",
    },
  },
  {
    id: "theme-github-dark",
    name: "GitHub Dark",
    term: ansi({
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#ffffff",
    }),
    syntax: {
      keyword: "#ff7b72",
      string: "#a5d6ff",
      number: "#79c0ff",
      comment: "#8b949e",
      function: "#d2a8ff",
      type: "#ffa657",
      property: "#79c0ff",
      tag: "#7ee787",
      operator: "#ff7b72",
      variable: "#e6edf3",
    },
  },
];

/** Scheme by extension id — `undefined` for anything else. */
export function schemeFor(id: string | undefined | null): ColorScheme | undefined {
  return id ? SCHEMES.find((s) => s.id === id) : undefined;
}

/** All the ids, for "which one is on?" scans. */
export const SCHEME_IDS: readonly string[] = SCHEMES.map((s) => s.id);
