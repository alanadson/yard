/**
 * Anotações — the markdown notebook (Ctrl+Shift+N).
 *
 * Three panes, information flowing left to right: the rail (notebooks,
 * statuses, labels, trash) narrows the list, the list narrows to one note,
 * and the note opens in the same four-mode markdown editor the files get.
 * Nothing here is project-scoped on purpose: the notebook is the user's
 * memory across every project.
 *
 * One notebook, two places to wear it: the switch in the top bar moves it
 * between them (`notesStore.place`):
 *
 * - `NotesCenter`: the whole central workspace area — a first-class view, no
 *   backdrop, sidebar and side panels still at hand. It *replaces* the grid
 *   and the canvas rather than covering them: a portal's page is an OS
 *   window no HTML sheet can cover, and the overlay this used to be painted
 *   the site on top of the notes. Unmounting the workspace hides every
 *   portal, so there is nothing left to paint through.
 * - `NotesEmbed`: the body of the notebook's pane tab, beside the CLIs.
 *
 * Only one of the two ever mounts at a time (see `NoteSurface`'s module
 * compartments): the centre takes the grid's place, so no pane (and no tab
 * body) is on screen while it is up.
 */
import { useEffect, useMemo } from "react";
import "../CodeEditor/editor.css";
import "./notes.css";
import {
  AlertTriangle,
  Maximize2,
  NotebookPen,
  PanelTop,
  Plus,
  X,
} from "lucide-react";

import { NotesRail } from "./NotesRail";
import { NoteList } from "./NoteList";
import { NoteEditor } from "./NoteEditor";
import { Resizer } from "../Resizer";
import { useT } from "../../hooks/useT";
import { tn } from "../../lib/i18n";
import {
  parseNotesQuery,
  visibleNotes,
  type Note,
} from "../../lib/notes";
import { LIST_DEFAULT, RAIL_DEFAULT, useNotes } from "../../stores/notesStore";
import { useProjects } from "../../stores/projectsStore";

type NotesVariant = "center" | "tab";

/** The notebook filling the central workspace area — a view, not a dialog. */
export function NotesCenter() {
  const t = useT();
  useLandingFocus();
  return (
    <section
      className="notes notes--center"
      aria-label={t("Anotações")}
      onKeyDown={(e) => {
        // The key that summoned it dismisses it even from inside a text
        // field. (The global handler covers the key when focus is elsewhere.)
        if (
          !e.defaultPrevented &&
          (e.ctrlKey || e.metaKey) &&
          e.shiftKey &&
          e.code === "KeyN"
        ) {
          e.preventDefault();
          e.stopPropagation();
          useNotes.getState().closeView();
          return;
        }
        notebookKeys(e);
      }}
    >
      <NotesShell variant="center" />
    </section>
  );
}

/** The notebook as the body of its pane tab. */
export function NotesEmbed() {
  const t = useT();
  useLandingFocus();
  return (
    <section
      className="notes notes--tab"
      aria-label={t("Anotações")}
      onKeyDown={notebookKeys}
    >
      <NotesShell variant="tab" />
    </section>
  );
}

/** Landing focus on mount: showing the notebook is a visit, and a visit
 *  usually starts at the search box, unless something already asked for the
 *  title (a note just created). */
function useLandingFocus() {
  useEffect(() => {
    if (!useNotes.getState().wantsFocus) useNotes.getState().focusSearch();
  }, []);
}

/**
 * The notebook's keys, scoped to focus inside it: a window listener would
 * fire with the cursor in a CLI two panes away. Esc is deliberately absent:
 * these are views, not dialogs.
 */
function notebookKeys(e: React.KeyboardEvent) {
  if (e.defaultPrevented) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  // Ctrl+N — a new note. Ctrl+Shift+F — the search box (stopped so the
  // global handler does not also open the project search underneath).
  if (!e.shiftKey && e.code === "KeyN") {
    e.preventDefault();
    e.stopPropagation();
    useNotes.getState().createNote();
    return;
  }
  if (e.shiftKey && e.code === "KeyF") {
    e.preventDefault();
    e.stopPropagation();
    useNotes.getState().focusSearch();
  }
}

/** The two place buttons: where the notebook opens, switchable in place. */
function PlaceSwitch() {
  const placeKind = useNotes((s) => s.place.kind);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const t = useT();
  return (
    <div className="md-modes" role="group" aria-label={t("Onde o caderno abre")}>
      <button
        className={`icon-btn ${placeKind === "tab" ? "is-active" : ""}`}
        data-tip={
          activeGroupId
            ? t("Em aba — no painel em foco, ao lado das CLIs")
            : t("Em aba — abra um grupo primeiro")
        }
        aria-label={t("Abrir em aba no painel")}
        aria-pressed={placeKind === "tab"}
        disabled={!activeGroupId}
        onClick={() => {
          if (useNotes.getState().place.kind !== "tab") useNotes.getState().dockHere();
        }}
      >
        <PanelTop size={14} />
      </button>
      <button
        className={`icon-btn ${placeKind === "center" ? "is-active" : ""}`}
        data-tip={t("Área central — ocupa todo o espaço do workspace")}
        aria-label={t("Ocupar a área central")}
        aria-pressed={placeKind === "center"}
        onClick={() => useNotes.getState().placeCenter()}
      >
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

/** Top bar + the three panes — the notebook itself, whatever it is worn as. */
function NotesShell({ variant }: { variant: NotesVariant }) {
  const railW = useNotes((s) => s.railW);
  const listW = useNotes((s) => s.listW);
  const saveError = useNotes((s) => s.saveError);
  const total = useNotes((s) => s.notes.reduce((n, x) => n + (x.deletedAt === null ? 1 : 0), 0));
  const t = useT();

  return (
    <>
      <header className="notes-topbar">
        <span className="notes-brand">
          <NotebookPen size={14} aria-hidden="true" />
          {t("Anotações")}
          {total > 0 && (
            <span className="notes-brand-count">
              {tn(total, "{n} nota", "{n} notas")}
            </span>
          )}
        </span>
        {saveError && (
          <span className="notes-savewarn" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            {t("Não estou conseguindo gravar — a última mudança ainda não foi salva.")}
          </span>
        )}
        <div className="notes-topbar-right">
          <PlaceSwitch />
          <button
            className="btn btn--primary btn--sm"
            data-tip={t("Nova nota (Ctrl+N)")}
            onClick={() => useNotes.getState().createNote()}
          >
            <Plus size={12} aria-hidden="true" /> {t("Nova nota")}
          </button>
          {/* A tab closes on its own X in the bar; the centre closes here. */}
          {variant === "center" && (
            <button
              className="icon-btn"
              data-tip={t("Fechar — volta ao grid")}
              data-tip-at="right"
              aria-label={t("Fechar as anotações")}
              onClick={() => useNotes.getState().closeView()}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </header>

      <div className="notes-body">
        <aside className="notes-rail" style={{ width: railW }}>
          <NotesRail />
          <Resizer
            side="right"
            width={railW}
            min={184}
            max={320}
            defaultWidth={RAIL_DEFAULT}
            label={t("Largura da coluna de cadernos")}
            onResize={(w) => useNotes.getState().setRailW(w)}
            onCommit={(w) => useNotes.getState().setRailW(w, true)}
          />
        </aside>
        <section className="notes-listpane" style={{ width: listW }}>
          <NoteList />
          <Resizer
            side="right"
            width={listW}
            min={248}
            max={440}
            defaultWidth={LIST_DEFAULT}
            label={t("Largura da lista de notas")}
            onResize={(w) => useNotes.getState().setListW(w)}
            onCommit={(w) => useNotes.getState().setListW(w, true)}
          />
        </section>
        <section className="notes-editorpane">
          <NoteEditor />
        </section>
      </div>
    </>
  );
}

/**
 * The rows the list pane is showing right now — shared by the list and by the
 * "which note comes next after this one dies" logic. One projection string
 * subscription would not survive the query typing, so the pieces are
 * subscribed raw and memoized; the notes array only changes identity on real
 * edits, which is exactly when recomputing is due.
 */
export function useVisibleNotes(): Note[] {
  const notes = useNotes((s) => s.notes);
  const notebooks = useNotes((s) => s.notebooks);
  const tags = useNotes((s) => s.tags);
  const collection = useNotes((s) => s.collection);
  const query = useNotes((s) => s.query);
  const sort = useNotes((s) => s.sort);
  const showResolved = useNotes((s) => s.showResolved);

  return useMemo(
    () =>
      visibleNotes({
        notes,
        collection,
        query: parseNotesQuery(query),
        ctx: { notebooks, tags },
        sort,
        showResolved,
      }),
    [notes, notebooks, tags, collection, query, sort, showResolved],
  );
}
