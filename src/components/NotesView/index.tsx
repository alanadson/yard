/**
 * Anotações — the markdown notebook (Ctrl+Shift+N).
 *
 * Three panes, information flowing left to right: the rail (notebooks,
 * statuses, labels, trash) narrows the list, the list narrows to one note,
 * and the note opens in the same four-mode markdown editor the files get.
 * Nothing here is project-scoped on purpose: the notebook is the user's
 * memory across every project.
 *
 * One notebook, three places to wear it — the switch in the top bar moves it
 * between them (`notesStore.place`):
 *
 * - `NotesView`: the original overlay, raised over the workspace. Follows the
 *   editor's manners: `Esc` closes it (top layer only), the backdrop click
 *   closes it, and everything typed keeps living in the store.
 * - `NotesCenter`: the whole central workspace area — a first-class view, no
 *   backdrop, sidebar and side panels still at hand.
 * - `NotesEmbed`: the body of the notebook's pane tab, beside the CLIs.
 *
 * Only one of the three ever mounts at a time (see `NoteSurface`'s module
 * compartments): the store keeps a single `place`, the pane only mounts the
 * active tab, and the embed steps aside while the peek overlay is up.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import "../CodeEditor/editor.css";
import "./notes.css";
import {
  AlertTriangle,
  AppWindow,
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
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isTopLayer } from "../../lib/layers";
import {
  parseNotesQuery,
  visibleNotes,
  type Note,
} from "../../lib/notes";
import { LIST_DEFAULT, RAIL_DEFAULT, useNotes } from "../../stores/notesStore";
import { useProjects } from "../../stores/projectsStore";

type NotesVariant = "overlay" | "center" | "tab";

/** The notebook as the overlay sheet — the original Ctrl+Shift+N surface. */
export function NotesView() {
  const open = useNotes((s) => s.open);
  const rootRef = useRef<HTMLDivElement>(null);

  useDialogFocus(rootRef, open, "anotacoes");

  const close = useCallback(() => useNotes.getState().closeView(), []);

  // Landing focus: the search box, unless something already asked for the
  // title (a note just created) — the box is where a visit usually starts.
  useEffect(() => {
    if (open && !useNotes.getState().wantsFocus) useNotes.getState().focusSearch();
  }, [open]);

  // The view's own keys — only while it is the top surface, and never a key
  // someone underneath (CodeMirror panels, the Select list) already claimed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!isTopLayer("anotacoes")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      // Ctrl+Shift+N — the same key that opened it closes it; the global
      // handler cannot see it while a full surface is up.
      if (e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        close();
        return;
      }
      // Ctrl+N — a new note, from anywhere inside the view.
      if (!e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        useNotes.getState().createNote();
        return;
      }
      // Ctrl+Shift+F — the search box (inside the editor, Ctrl+F is CodeMirror's).
      if (e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        useNotes.getState().focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    // Only the primary button closes: with the right one the gesture is "open
    // the menu", and closing the notebook from under it would be the wrong answer.
    <div className="notes-backdrop" onMouseDown={(e) => e.button === 0 && close()}>
      <div
        ref={rootRef}
        className="notes"
        role="dialog"
        aria-modal="true"
        aria-label="Anotações"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <NotesShell variant="overlay" />
      </div>
    </div>
  );
}

/** The notebook filling the central workspace area — a view, not a dialog. */
export function NotesCenter() {
  useLandingFocus();
  return (
    <section
      className="notes notes--center"
      aria-label="Anotações"
      onKeyDown={(e) => {
        // The key that summoned it dismisses it even from inside a text
        // field — the overlay behaves this way, the central place follows.
        // (The global handler covers the key when focus is elsewhere.)
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
  // The peek overlay (a canvas-mode group's answer to Ctrl+Shift+N) is the
  // one case where the tab could be mounted at the same time as the sheet —
  // and two surfaces may never mount together, so the tab yields.
  const overlayUp = useNotes((s) => s.open);
  useLandingFocus();
  if (overlayUp) return null;
  return (
    <section
      className="notes notes--tab"
      aria-label="Anotações"
      onKeyDown={notebookKeys}
    >
      <NotesShell variant="tab" />
    </section>
  );
}

/** Same landing the overlay does, on mount — activating the tab is a visit. */
function useLandingFocus() {
  useEffect(() => {
    if (!useNotes.getState().wantsFocus) useNotes.getState().focusSearch();
  }, []);
}

/**
 * The embedded variants' keys, scoped to focus inside the notebook — a
 * window listener would fire with the cursor in a CLI two panes away. Esc is
 * deliberately absent: these are views, not dialogs.
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

/** The three place buttons — where the notebook opens, switchable in place. */
function PlaceSwitch() {
  const placeKind = useNotes((s) => s.place.kind);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  return (
    <div className="md-modes" role="group" aria-label="Onde o caderno abre">
      <button
        className={`icon-btn ${placeKind === "overlay" ? "is-active" : ""}`}
        data-tip="Sobreposto — o caderno flutua sobre a tela"
        aria-label="Abrir sobreposto"
        aria-pressed={placeKind === "overlay"}
        onClick={() => useNotes.getState().setPlaceKind("overlay")}
      >
        <AppWindow size={14} />
      </button>
      <button
        className={`icon-btn ${placeKind === "tab" ? "is-active" : ""}`}
        data-tip={
          activeGroupId
            ? "Em aba — no painel em foco, ao lado das CLIs"
            : "Em aba — abra um grupo primeiro"
        }
        aria-label="Abrir em aba no painel"
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
        data-tip="Área central — ocupa todo o espaço do workspace"
        aria-label="Ocupar a área central"
        aria-pressed={placeKind === "center"}
        onClick={() => useNotes.getState().setPlaceKind("center")}
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

  return (
    <>
      <header className="notes-topbar">
        <span className="notes-brand">
          <NotebookPen size={14} aria-hidden="true" />
          Anotações
          {total > 0 && (
            <span className="notes-brand-count">
              {total} {total === 1 ? "nota" : "notas"}
            </span>
          )}
        </span>
        {saveError && (
          <span className="notes-savewarn" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            Não estou conseguindo gravar — a última mudança ainda não foi salva.
          </span>
        )}
        <div className="notes-topbar-right">
          <PlaceSwitch />
          <button
            className="btn btn--primary btn--sm"
            data-tip="Nova nota (Ctrl+N)"
            onClick={() => useNotes.getState().createNote()}
          >
            <Plus size={12} aria-hidden="true" /> Nova nota
          </button>
          {/* A tab closes on its own X in the bar; the other two close here. */}
          {variant !== "tab" && (
            <button
              className="icon-btn"
              data-tip={variant === "overlay" ? "Fechar (Esc)" : "Fechar — volta ao grid"}
              data-tip-at="right"
              aria-label="Fechar as anotações"
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
            label="Largura da coluna de cadernos"
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
            label="Largura da lista de notas"
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
