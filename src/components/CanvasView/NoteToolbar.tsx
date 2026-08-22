/**
 * The formatting bar a note wears while you are writing in it.
 *
 * Docked at the **top of the canvas**, not floating over the note. Hugging
 * the note read well on an empty board and badly on a real one: a note is
 * usually the biggest thing in frame, so anything that opened from a bar
 * glued to its top edge landed on the very text being written. A fixed strip
 * has a second virtue — it does not move while you type, so the button you
 * are reaching for is where it was a second ago.
 *
 * Screen space, never inside `.cv-world`: a bar that scaled with the zoom
 * would be 11px tall on a board at 40%, which is when a small note needs one.
 *
 * It is the tool rail on the left, laid on its side: same capsule, same 26px
 * slots at 14px icons, same dividers, same solid blue for what is held. Two
 * floating capsules on one screen either read as one instrument or as an
 * accident, and there is no third option.
 *
 * The bar never owns the text. It asks the note's editor to run a command
 * (`NoteEditorApi`) and the note applies it to its own `<textarea>`, so the
 * caret, the draft and the debounce all stay in one place.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Code,
  CopyPlus,
  Ellipsis,
  Eraser,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  SquareCheckBig,
  SquareCode,
  Strikethrough,
  TextQuote,
} from "lucide-react";

import type { BlockKind, MdCommand } from "../../lib/mdedit";
import { useOccluders } from "../../stores/occludersStore";

/**
 * What the note hands the bar. Deliberately three functions and no data:
 * the caret moves on every keystroke, and pushing that through the canvas's
 * state would re-render the whole board to light up one button.
 */
export interface NoteEditorApi {
  run: (cmd: MdCommand) => void;
  /** Block marker under the caret — the button that shows pressed. */
  block: () => BlockKind;
  subscribe: (onChange: () => void) => () => void;
}

interface Btn {
  cmd: MdCommand;
  icon: React.ReactNode;
  label: string;
  keys: string;
  /** Word on the chip, in the second row. */
  short?: string;
  /** Set when the button reflects a block the caret can already be inside. */
  on?: BlockKind;
}

/** In the top row: title, emphasis, structure. */
const MAIN: (Btn | "sep")[] = [
  { cmd: "h1", icon: <Heading1 size={14} />, label: "Título 1", keys: "Ctrl+1", on: "h1" },
  { cmd: "h2", icon: <Heading2 size={14} />, label: "Título 2", keys: "Ctrl+2", on: "h2" },
  { cmd: "h3", icon: <Heading3 size={14} />, label: "Título 3", keys: "Ctrl+3", on: "h3" },
  "sep",
  { cmd: "bold", icon: <Bold size={14} />, label: "Negrito", keys: "Ctrl+B" },
  { cmd: "italic", icon: <Italic size={14} />, label: "Itálico", keys: "Ctrl+I" },
  { cmd: "strike", icon: <Strikethrough size={14} />, label: "Riscado", keys: "Ctrl+Shift+X" },
  { cmd: "highlight", icon: <Highlighter size={14} />, label: "Marca-texto", keys: "Ctrl+Shift+H" },
  { cmd: "code", icon: <Code size={14} />, label: "Código na linha", keys: "Ctrl+E" },
  { cmd: "link", icon: <Link2 size={14} />, label: "Link", keys: "Ctrl+K" },
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
  { cmd: "quote", icon: <TextQuote size={14} />, label: "Citação", keys: "Ctrl+Shift+.", on: "quote" },
  {
    cmd: "codeblock",
    icon: <SquareCode size={14} />,
    label: "Bloco de código",
    keys: "Ctrl+Shift+C",
  },
];

/**
 * The second row, behind the ⋯. Named chips and not more icons: these are the
 * commands nobody has a picture for in their head, so the word is the point.
 */
const MORE: Btn[] = [
  {
    cmd: "paragraph",
    icon: <Pilcrow size={14} />,
    label: "Parágrafo — tira a marcação da linha",
    short: "Parágrafo",
    keys: "Ctrl+0",
  },
  { cmd: "rule", icon: <Minus size={14} />, label: "Linha divisória", short: "Régua", keys: "Ctrl+Shift+−" },
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
  /** Read late: the note registers its editor after the bar has mounted. */
  api: () => NoteEditorApi | null;
}

const NO_SUB = () => () => {};

export function NoteToolbar({ api }: Props) {
  const [more, setMore] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const subscribe = useCallback(
    (cb: () => void) => api()?.subscribe(cb) ?? NO_SUB(),
    [api],
  );
  const snapshot = useCallback((): BlockKind => api()?.block() ?? "paragraph", [api]);
  const block = useSyncExternalStore(subscribe, snapshot);

  /**
   * A portal's page is an OS window over the DOM and would swallow this bar
   * whole. Publishing where it landed lets exactly the portals under it step
   * aside — the ones elsewhere on the board keep showing their site.
   */
  const occluderKey = useId();
  const setOccluder = useOccluders((s) => s.setOccluder);
  useEffect(() => () => setOccluder(occluderKey, null), [occluderKey, setOccluder]);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOccluder(occluderKey, { x: r.left, y: r.top, w: r.width, h: r.height });
  }, [more, occluderKey, setOccluder]);

  const run = (cmd: MdCommand) => api()?.run(cmd);

  return (
    <div
      ref={rootRef}
      className="cv-mdbar"
      role="toolbar"
      aria-label="Formatação da nota"
      // Two jobs in one handler. `stopPropagation` keeps the canvas from
      // reading the press as "clicked outside the note, stop editing", and
      // `preventDefault` kills the compatibility mousedown whose focus walk
      // would blur the very textarea the command is about to edit. `click`
      // still fires — the spec only suppresses the mouse events.
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <div className="cv-mdbar-row">
        {MAIN.map((b, i) =>
          b === "sep" ? (
            <div key={`s${i}`} className="cv-mdbar-sep" />
          ) : (
            <button
              key={b.cmd}
              className={`icon-btn ${b.on && block === b.on ? "is-active" : ""}`}
              data-tip={`${b.label} (${b.keys})`}
              aria-label={b.label}
              aria-pressed={b.on ? block === b.on : undefined}
              onClick={() => run(b.cmd)}
            >
              {b.icon}
            </button>
          ),
        )}
        <div className="cv-mdbar-sep" />
        <button
          className={`icon-btn ${more ? "is-active" : ""}`}
          data-tip={more ? "Menos comandos" : "Mais comandos"}
          aria-label={more ? "Menos comandos" : "Mais comandos"}
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          <Ellipsis size={14} />
        </button>
      </div>

      {/* A second row *inside* the capsule, not a menu hanging off it: this
          bar sits above a note that fills most of the frame, and anything
          that dropped down would cover the text it is meant to format. */}
      {more && (
        <div className="cv-mdbar-extra" role="group" aria-label="Mais comandos">
          {MORE.map((b) => (
            <button
              key={b.cmd}
              className="cv-mdchip"
              data-tip={`${b.label} (${b.keys})`}
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
