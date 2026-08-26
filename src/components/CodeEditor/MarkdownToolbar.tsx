/**
 * The formatting bar of a markdown file.
 *
 * The canvas note has one of these (`NoteToolbar`) and this is deliberately
 * its bigger sibling: same slots, same 14px icons, same dividers, same
 * pressed state driven by the block under the caret — a person who learned
 * the bar on a sticky note already knows this one. What it adds is
 * everything a *file* has and a note does not: headings down to six, tables,
 * images, footnotes, the whole line-surgery set.
 *
 * It never owns the text. Every button asks the editor's view to run a
 * command (`runMd`), so the caret, the undo history and the draft all stay in
 * exactly one place — CodeMirror.
 *
 * i18n-scan: tables — the labels below are keys; `t()` runs where they are
 * rendered.
 */
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  BookOpen,
  ChevronDown,
  Code,
  Code2,
  Columns2,
  CopyPlus,
  Ellipsis,
  Eraser,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Highlighter,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pencil,
  Pilcrow,
  Quote,
  SquareCheckBig,
  SquareCode,
  Strikethrough,
  Superscript,
  Table,
} from "lucide-react";

import type { BlockKind, MdCommand } from "../../lib/mdedit";
import type { MdMode } from "../../stores/editorStore";
import type { MdBarSlots } from "./chrome";
import { useT } from "../../hooks/useT";

/**
 * The four ways to look at a markdown file, in the order of how much of the
 * source they show — from "drawn like the page" to "read only the page".
 *
 * They sit on this bar and no longer on the path row: choosing the face of
 * the text belongs with the buttons that shape it. Kept as their own
 * instrument at the end — the app's segmented control, a recessed track with
 * the active segment raised — so nobody reads a *view* as one more formatting
 * command.
 */
const MODES: { mode: MdMode; icon: React.ReactNode; label: string; hint: string }[] = [
  {
    mode: "live",
    icon: <Pencil size={14} />,
    label: "Editar", // i18n-ok — a key, rendered through t()
    hint: "escreve markdown já desenhado", // i18n-ok
  },
  {
    mode: "source",
    icon: <Code2 size={14} />,
    // "Fonte do markdown", not "Fonte": the bare word is the *font* everywhere
    // else in the app, and one Portuguese key carries one English line.
    label: "Fonte do markdown", // i18n-ok
    hint: "o texto cru, como o agente lê", // i18n-ok
  },
  {
    mode: "split",
    icon: <Columns2 size={14} />,
    label: "Dividido", // i18n-ok
    hint: "fonte de um lado, página do outro", // i18n-ok
  },
  {
    mode: "read",
    icon: <BookOpen size={14} />,
    label: "Ler", // i18n-ok
    hint: "só a página, largura toda", // i18n-ok
  },
];

interface Btn {
  cmd: MdCommand;
  icon: React.ReactNode;
  label: string;
  keys: string;
  /** Word on the chip, in the overflow row. */
  short?: string;
  /** Set when the button reflects a block the caret can already be inside. */
  on?: BlockKind;
}

/** The row that is always visible: structure, emphasis, lists, links. */
const MAIN: (Btn | "sep")[] = [
  { cmd: "paragraph", icon: <Pilcrow size={14} />, label: "Parágrafo", keys: "Ctrl+0", on: "paragraph" },
  { cmd: "h1", icon: <Heading1 size={14} />, label: "Título 1", keys: "Ctrl+1", on: "h1" },
  { cmd: "h2", icon: <Heading2 size={14} />, label: "Título 2", keys: "Ctrl+2", on: "h2" },
  { cmd: "h3", icon: <Heading3 size={14} />, label: "Título 3", keys: "Ctrl+3", on: "h3" },
  "sep",
  { cmd: "bold", icon: <Bold size={14} />, label: "Negrito", keys: "Ctrl+B" },
  { cmd: "italic", icon: <Italic size={14} />, label: "Itálico", keys: "Ctrl+I" },
  { cmd: "strike", icon: <Strikethrough size={14} />, label: "Riscado", keys: "Ctrl+Shift+X" },
  { cmd: "highlight", icon: <Highlighter size={14} />, label: "Marca-texto", keys: "Ctrl+Shift+H" },
  { cmd: "code", icon: <Code size={14} />, label: "Código na linha", keys: "Ctrl+E" },
  "sep",
  { cmd: "bullet", icon: <List size={14} />, label: "Lista", keys: "Ctrl+Shift+8", on: "bullet" },
  {
    cmd: "ordered",
    icon: <ListOrdered size={14} />,
    label: "Lista numerada",
    keys: "Ctrl+Shift+7",
    on: "ordered",
  },
  {
    cmd: "task",
    icon: <ListTodo size={14} />,
    label: "Lista de tarefas",
    keys: "Ctrl+Shift+9",
    on: "task",
  },
  { cmd: "quote", icon: <Quote size={14} />, label: "Citação", keys: "Ctrl+Shift+.", on: "quote" },
  "sep",
  { cmd: "link", icon: <Link2 size={14} />, label: "Link", keys: "Ctrl+K" },
  { cmd: "image", icon: <Image size={14} />, label: "Imagem", keys: "Ctrl+Shift+I" },
  { cmd: "table", icon: <Table size={14} />, label: "Tabela", keys: "Ctrl+Shift+T" },
  {
    cmd: "codeblock",
    icon: <SquareCode size={14} />,
    label: "Bloco de código",
    keys: "Ctrl+Shift+C",
  },
];

/**
 * Behind the ⋯. Named chips and not more icons: nobody carries a picture of
 * "outdent" in their head, so the word is the point.
 */
const MORE: Btn[] = [
  { cmd: "h4", icon: <Heading4 size={14} />, label: "Título 4", short: "Título 4", keys: "Ctrl+4", on: "h4" },
  { cmd: "h5", icon: <Heading4 size={14} />, label: "Título 5", short: "Título 5", keys: "Ctrl+5", on: "h5" },
  { cmd: "h6", icon: <Heading4 size={14} />, label: "Título 6", short: "Título 6", keys: "Ctrl+6", on: "h6" },
  { cmd: "rule", icon: <Minus size={14} />, label: "Linha divisória", short: "Régua", keys: "Ctrl+Shift+−" },
  {
    cmd: "footnote",
    icon: <Superscript size={14} />,
    label: "Nota de rodapé — a marca aqui, o texto no fim do arquivo",
    short: "Rodapé",
    keys: "Ctrl+Shift+F",
  },
  {
    cmd: "toggleTask",
    icon: <SquareCheckBig size={14} />,
    label: "Concluir ou reabrir a tarefa",
    short: "Concluir",
    keys: "Ctrl+Enter",
  },
  { cmd: "indent", icon: <IndentIncrease size={14} />, label: "Recuar", short: "Recuar", keys: "Tab" },
  {
    cmd: "outdent",
    icon: <IndentDecrease size={14} />,
    label: "Tirar o recuo",
    short: "Voltar",
    keys: "Shift+Tab",
  },
  {
    cmd: "duplicate",
    icon: <CopyPlus size={14} />,
    label: "Duplicar a linha",
    short: "Duplicar",
    keys: "Ctrl+Shift+D",
  },
  { cmd: "moveUp", icon: <ArrowUp size={14} />, label: "Subir a linha", short: "Subir", keys: "Alt+↑" },
  { cmd: "moveDown", icon: <ArrowDown size={14} />, label: "Descer a linha", short: "Descer", keys: "Alt+↓" },
  {
    cmd: "clear",
    icon: <Eraser size={14} />,
    label: "Limpar a formatação",
    short: "Limpar",
    keys: "Ctrl+\\",
  },
];

interface Props {
  /** Block the caret is inside — which button shows pressed. */
  block: BlockKind;
  run: (cmd: MdCommand) => void;
  /** Which slots this file and mode ask for — see `mdBar`. */
  slots: MdBarSlots;
  /**
   * The face the file is showing, and how to change it — passed by the host
   * whose bar carries the modes (`slots.modes`). The note's does not: its
   * meta row already has them, next to the pin.
   */
  mode?: MdMode;
  onMode?: (mode: MdMode) => void;
  /** Read-only file: the bar stays visible, greyed, instead of disappearing. */
  disabled?: boolean;
}

/**
 * The row as groups — what the "sep" markers delimit. A group wraps as one
 * piece: in a narrow pane the bar breaks between families (headings,
 * emphasis, lists, inserts), never leaving one orphan slot on a line of its
 * own.
 */
const GROUPS: Btn[][] = MAIN.reduce<Btn[][]>(
  (acc, b) => {
    if (b === "sep") acc.push([]);
    else acc[acc.length - 1].push(b);
    return acc;
  },
  [[]],
);

export function MarkdownToolbar({ block, run, slots, mode, onMode, disabled }: Props) {
  const t = useT();
  const [more, setMore] = useState(false);

  const renderButton = (b: Btn) => (
    <button
      key={b.cmd}
      className={`icon-btn ${b.on && block === b.on ? "is-active" : ""}`}
      data-tip={`${t(b.label)} (${b.keys})`}
      aria-label={t(b.label)}
      aria-pressed={b.on ? block === b.on : undefined}
      disabled={disabled}
      onClick={() => run(b.cmd)}
    >
      {b.icon}
    </button>
  );

  return (
    <div
      className="md-bar"
      role="toolbar"
      // On the reading page the capsule is only the mode switch: naming it
      // "formatting" there would announce buttons that are not on it.
      aria-label={slots.formatting ? t("Formatação do markdown") : t("Como mostrar o markdown")}
      // The command edits whatever the caret was on: the press must not take
      // focus away from the editor first.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="md-bar-row">
        {slots.formatting && (
          <>
            {GROUPS.map((group, i) => (
              <span key={i} className="md-bar-group" role="group">
                {group.map(renderButton)}
              </span>
            ))}
            <span className="md-bar-group">
              <button
                className={`icon-btn ${more ? "is-active" : ""}`}
                data-tip={more ? t("Menos comandos") : t("Mais comandos")}
                aria-label={more ? t("Menos comandos") : t("Mais comandos")}
                aria-expanded={more}
                onClick={() => setMore((v) => !v)}
              >
                {more ? <ChevronDown size={14} /> : <Ellipsis size={14} />}
              </button>
            </span>
          </>
        )}
        {slots.modes && mode && onMode && (
          <span className="md-bar-group">
            <div className="md-modes" role="group" aria-label={t("Como mostrar o markdown")}>
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  className={mode === m.mode ? "is-active" : ""}
                  data-tip={`${t(m.label)} — ${t(m.hint)}`}
                  aria-label={t(m.label)}
                  aria-pressed={mode === m.mode}
                  onClick={() => onMode(m.mode)}
                >
                  {m.icon}
                </button>
              ))}
            </div>
          </span>
        )}
      </div>

      {/* A second row inside the bar, not a menu hanging off it: a dropdown
          would cover the first lines of the very text being formatted. */}
      {slots.formatting && more && (
        <div className="md-bar-extra" role="group" aria-label={t("Mais comandos")}>
          {MORE.map((b) => (
            <button
              key={b.cmd}
              className={`md-chip ${b.on && block === b.on ? "is-active" : ""}`}
              data-tip={`${t(b.label)} (${b.keys})`}
              aria-pressed={b.on ? block === b.on : undefined}
              disabled={disabled}
              onClick={() => run(b.cmd)}
            >
              {b.icon}
              <span>{t(b.short ?? b.label)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
