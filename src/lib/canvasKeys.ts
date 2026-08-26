/**
 * The board's keyboard decisions that do not depend on the DOM.
 *
 * They live here, not inside `CanvasView`, because each one is an
 * accessibility rule that needs to be locked down by a test: a `Tab` that
 * cycles too far becomes a keyboard trap, and an `Escape` that does not
 * release the board leaves the user with no way out. See `canvasKeys.test.ts`.
 */
import { noteName, portalName, type CanvasItem, type CanvasItemType } from "./canvas";
import { t } from "./i18n";

/** Where focus is, from the point of view of the board's shortcuts. */
export interface BoardFocus {
  /** Is the focused element `.cv` itself (which is `tabIndex={-1}`)? */
  readonly isBoard: boolean;
  /** Is it inside `.cv` — a card button, a note field, whatever? */
  readonly insideBoard: boolean;
}

/**
 * `percorre` = the selection moves to the next item, like in a drawing app.
 * `navega` = the browser moves focus to the next control, like everywhere else.
 */
export type TabAction = "percorre" | "navega";

/**
 * The board only keeps `Tab` when it has focus itself.
 *
 * With focus on a control **inside** a card, `Tab` belongs to the browser:
 * that is exactly where the keyboard got trapped, because the cycle does not
 * move DOM focus — it only changes the selection, and focus stayed where it
 * was forever. With no focus at all (the `document.body` of right after boot)
 * `Tab` also belongs to the browser, otherwise the sidebar is unreachable on
 * the session's first interaction.
 */
export function tabAction(focus: BoardFocus): TabAction {
  return focus.isBoard ? "percorre" : "navega";
}

/** The state `Escape` consults, in the order it undoes things. */
export interface EscState {
  /** A stroke/shape is being drawn at this instant. */
  readonly strokeDraft: boolean;
  /** A connection left a card and has not yet arrived at another. */
  readonly connecting: boolean;
  readonly selectedCount: number;
  readonly activeTool: string;
}

export type EscStep =
  | "limpa-rascunho"
  | "cancela-conexao"
  | "limpa-selecao"
  | "volta-para-selecionar"
  | "solta-o-tabuleiro";

/**
 * One `Escape` undoes one thing at a time, from the most ephemeral to the most
 * stable.
 *
 * The last step is what closes the trap: with nothing to cancel and already on
 * the select tool, `Escape` gives focus back to the document. It is the
 * keyboard exit WCAG 2.1.2 demands, and it uses the key everybody tries anyway.
 */
export function escStep(theState: EscState): EscStep {
  if (theState.strokeDraft) return "limpa-rascunho";
  if (theState.connecting) return "cancela-conexao";
  if (theState.selectedCount > 0) return "limpa-selecao";
  if (theState.activeTool !== "select") return "volta-para-selecionar";
  return "solta-o-tabuleiro";
}

/** The item the `Tab` cycle just stopped on. */
export type CycleTarget =
  | { readonly kind: "terminal"; readonly name: string }
  | { readonly kind: "item"; readonly type: CanvasItemType; readonly name?: string };

// i18n-scan: tables — the kind labels are wrapped with t() in selectionAnnouncement.
const KIND_LABELS: Record<CanvasItemType, string> = {
  stroke: "Desenho",
  rect: "Retângulo",
  ellipse: "Elipse",
  line: "Linha",
  arrow: "Seta",
  text: "Texto",
  note: "Nota",
  portal: "Portal",
  flow: "Fluxo",
  media: "Arquivo",
  binder: "Fichário",
  tree: "Árvore de arquivos",
  group: "Grupo",
  connection: "Conexão",
};

/**
 * The sentence the screen reader hears when the cycle switches item.
 *
 * Selection is **not** focus: the cycle paints the border and brings the
 * camera to the item, but DOM focus never leaves the board, so none of that
 * reaches assistive technology on its own. The position in the round ("3 de
 * 12") is what says the key had an effect when two neighboring items share a
 * name.
 */
export function selectionAnnouncement(target: CycleTarget, index: number, total: number): string {
  const position = t("{n} de {total}", { n: index + 1, total });
  if (target.kind === "terminal") return `Terminal ${target.name}, ${position}`;
  const itemName = target.name?.trim();
  const kind = t(KIND_LABELS[target.type]);
  return itemName ? `${kind} ${itemName}, ${position}` : `${kind}, ${position}`;
}

/**
 * How a drawn item introduces itself in the announcement.
 *
 * Reuses the same names the CLI uses to address notes and portals
 * (`noteName`/`portalName`) — two names for the same thing would be worse than
 * no name. Whatever has no name returns `undefined`: then the kind alone
 * ("Desenho, 3 de 12") already says enough.
 */
export function itemName(item: CanvasItem): string | undefined {
  switch (item.type) {
    case "note":
      return noteName(item);
    case "portal":
      return portalName(item);
    case "text":
      return item.text.trim().slice(0, 48) || undefined;
    case "flow":
      return item.name?.trim() || undefined;
    default:
      return undefined;
  }
}
