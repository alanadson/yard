/**
 * The Settings menu: one category per row, and what the main column's header
 * says while it is open.
 *
 * It lives here, outside the JSX, for two reasons. The first is validation:
 * the open category arrives from outside (`openModal("preferences",
 * "dados")`, a search item) and a value from outside is a value to
 * validate. The second is that the list is the screen's index — whoever adds
 * a category adds an entry here, and the menu, the routing and the header all
 * learn about it at once.
 *
 * `tone` is the icon's colored square. Chroma here is *section identity* (the
 * same role an app icon plays in a system's settings), the one agreed
 * exception to the "blue is the chrome's only color" rule — and it holds
 * because the menu is a list of destinations, not of actions.
 *
 * The texts are a table: they stay in Portuguese here and go through `t()`
 * where the menu renders them (`Settings/index.tsx`). // i18n-scan: tables
 */
export type SettingsCategory =
  | "interface"
  | "terminal"
  | "editor"
  | "agentes"
  | "comportamento"
  | "atalhos"
  | "dados"
  | "mcp";

export interface SettingsCategoryEntry {
  id: SettingsCategory;
  /** Menu row. */
  label: string;
  /** Title of the main column. */
  title: string;
  /** The line under the title — what gets adjusted there. */
  desc: string;
  /** Color of the icon's square, as a token or a literal. */
  tone: string;
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryEntry[] = [
  {
    id: "interface",
    label: "Interface",
    title: "Interface",
    desc: "Fonte e aparência do aplicativo",
    tone: "var(--accent)",
  },
  {
    id: "terminal",
    label: "Terminal",
    title: "Terminal",
    desc: "Fonte, renderização e histórico dos terminais",
    tone: "#3a3a40",
  },
  {
    id: "editor",
    label: "Editor de código",
    title: "Editor de código",
    desc: "Como o editor de arquivos desenha e indenta o código",
    tone: "#bf5af2",
  },
  {
    id: "agentes",
    label: "Agentes",
    title: "Agentes",
    desc: "Como cada CLI de código abre, e o que avisa quando ela para",
    tone: "#2fae54",
  },
  {
    id: "comportamento",
    label: "Comportamento",
    title: "Comportamento",
    desc: "Confirmações e padrões do aplicativo",
    tone: "#8e8e93",
  },
  {
    id: "atalhos",
    label: "Atalhos",
    title: "Atalhos",
    desc: "O mapa de teclado do Yard",
    tone: "#5e5ce6",
  },
  {
    id: "dados",
    label: "Dados e backup",
    title: "Dados e backup",
    desc: "Onde o Yard guarda o workspace, e como levá-lo junto",
    tone: "#ff9f0a",
  },
  {
    id: "mcp",
    label: "Servidores MCP",
    title: "Servidores MCP",
    desc: "Os servidores de ferramentas de cada CLI, num lugar só",
    tone: "#30b0c7",
  },
];

/** The one that opens when nobody asked for anything — the first in the menu. */
const DEFAULT_CATEGORY = SETTINGS_CATEGORIES[0].id;

/** A category from outside, sifted; what is not a category becomes the default. */
export function isValidCategory(raw: unknown): SettingsCategory {
  return SETTINGS_CATEGORIES.some((c) => c.id === raw)
    ? (raw as SettingsCategory)
    : DEFAULT_CATEGORY;
}

/** The main column's header for the open category. */
export function category(id: SettingsCategory): SettingsCategoryEntry {
  return SETTINGS_CATEGORIES.find((c) => c.id === id) ?? SETTINGS_CATEGORIES[0];
}
