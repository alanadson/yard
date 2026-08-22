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
 */
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  ChevronDown,
  Code,
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
  Pilcrow,
  Quote,
  SquareCheckBig,
  SquareCode,
  Strikethrough,
  Superscript,
  Table,
} from "lucide-react";

import type { BlockKind, MdCommand } from "../../lib/mdedit";

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
  /** Read-only file: the bar stays visible, greyed, instead of disappearing. */
  disabled?: boolean;
}

export function MarkdownToolbar({ block, run, disabled }: Props) {
  const [more, setMore] = useState(false);

  const renderButton = (b: Btn) => (
    <button
      key={b.cmd}
      className={`icon-btn ${b.on && block === b.on ? "is-active" : ""}`}
      data-tip={`${b.label} (${b.keys})`}
      aria-label={b.label}
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
      aria-label="Formatação do markdown"
      // The command edits whatever the caret was on: the press must not take
      // focus away from the editor first.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="md-bar-row">
        {MAIN.map((b, i) => (b === "sep" ? <span key={`s${i}`} className="md-bar-sep" /> : renderButton(b)))}
        <span className="md-bar-sep" />
        <button
          className={`icon-btn ${more ? "is-active" : ""}`}
          data-tip={more ? "Menos comandos" : "Mais comandos"}
          aria-label={more ? "Menos comandos" : "Mais comandos"}
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          {more ? <ChevronDown size={14} /> : <Ellipsis size={14} />}
        </button>
      </div>

      {/* A second row inside the bar, not a menu hanging off it: a dropdown
          would cover the first lines of the very text being formatted. */}
      {more && (
        <div className="md-bar-extra" role="group" aria-label="Mais comandos">
          {MORE.map((b) => (
            <button
              key={b.cmd}
              className={`md-chip ${b.on && block === b.on ? "is-active" : ""}`}
              data-tip={`${b.label} (${b.keys})`}
              aria-pressed={b.on ? block === b.on : undefined}
              disabled={disabled}
              onClick={() => run(b.cmd)}
            >
              {b.icon}
              <span>{b.short}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
