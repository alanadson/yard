/**
 * The pane grid.
 *
 * By default there is **a single pane**, filling the whole screen: a new
 * terminal is born in slot 0 and becomes another tab. The screen only
 * splits when the user drags a tab onto another pane (or pins a grid on
 * the title bar).
 *
 * Three shapes (§F2):
 *
 * - **auto**: the pane count follows the number of occupied slots (1/2/4);
 * - **grid**: the user pins 1–6 panes;
 * - **spotlight**: one large pane and the rest in a column beside it.
 *
 * The canvas is not a fourth shape: it is the group's **other surface**
 * (`layout.surface`), with terminals of its own. This component draws
 * whichever of the two is showing, and never mixes their CLIs — see
 * `lib/surface.ts`.
 *
 * The dividers are `react-resizable-panels`; each pane's size is session
 * state, not workspace state — what persists is the mode and the count.
 */
import { lazy, Suspense, useMemo, useState } from "react";
import { Globe, Plus } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { ContextMenu, type MenuAnchor } from "../ContextMenu";
import { ErrorBoundary } from "../ErrorBoundary";
import { FloorsControl } from "../Floors";
import { FlowRunsBar } from "../CanvasView/FlowHud";
import { TerminalPane } from "../TerminalPane";
import { useT } from "../../hooks/useT";
import { range } from "../../lib/format";
import { show } from "../../lib/navigate";
import { paneMenu } from "../../lib/paneMenu";
import { onSurface } from "../../lib/surface";
import { useBrowsers, type PaneBrowser } from "../../stores/browsersStore";
import { useEditor, type OpenDoc } from "../../stores/editorStore";
import { NOTES_TAB_ID, useNotes } from "../../stores/notesStore";
import { parseLayout, useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import type { TerminalRow } from "../../lib/ipc";

/**
 * Loaded on demand: the canvas drags in roughjs and perfect-freehand, and a
 * workspace that only ever uses the tab grid should not pay for a drawing
 * engine at startup.
 */
const CanvasView = lazy(() =>
  import("../CanvasView").then((m) => ({ default: m.CanvasView })),
);

interface Props {
  groupId: string;
}

/**
 * The group body + the Floors control in the bottom-right corner —
 * present in every mode, because switching floors does not depend on the canvas.
 */
export function WorkspaceGrid({ groupId }: Props) {
  const onBoard = useProjects((s) => s.layoutOf(groupId).surface === "canvas");
  // Floors are worktrees of a project, and a board has no project — its cards
  // each carry their own folder. So the control has nothing to switch there.
  const isBoard = useProjects((s) => s.isBoard(groupId));
  return (
    <>
      <GridBody groupId={groupId} />
      {/* On the canvas the full HUD already lives inside it; outside it, the
          running pipeline needs to exist somewhere — it was the only way to
          know which stage it is at and to cancel. */}
      {!onBoard && <FlowRunsBar groupId={groupId} />}
      {!isBoard && (
        <FloorsControl groupId={groupId} variant={onBoard ? "canvas" : "grid"} />
      )}
    </>
  );
}

function GridBody({ groupId }: Props) {
  const t = useT();
  // The selector returns the store's raw reference. Filtering inside it
  // would create a new array on every call, and since Zustand compares by
  // identity that becomes "Maximum update depth exceeded" — the render
  // feeds itself. Every list slice goes into `useMemo`.
  const allTerminals = useProjects((s) => s.terminals);
  const groups = useProjects((s) => s.groups);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);

  const terminals = useMemo(
    () => allTerminals.filter((t) => t.groupId === groupId),
    [allTerminals, groupId],
  );
  // The two surfaces no longer draw the same CLIs: a card recruited on the
  // board is not a tab of any pane, and a tab is not a card. Everything below
  // this line is about the panes; the canvas gets its own slice.
  const paneTerminals = useMemo(() => onSurface(terminals, "grid"), [terminals]);
  const cardTerminals = useMemo(() => onSurface(terminals, "canvas"), [terminals]);

  const layout = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return parseLayout(g?.layoutJson ?? "");
  }, [groups, groupId]);

  const bySlot = useMemo(() => {
    const map = new Map<number, TerminalRow[]>();
    for (const t of paneTerminals) {
      const list = map.get(t.slot) ?? [];
      list.push(t);
      map.set(t.slot, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort - b.sort);
    return map;
  }, [paneTerminals]);

  // Open files are tabs of a pane, exactly like the CLIs — so they are sliced
  // by slot here and handed over the same way. The subscription is on the
  // identity of the list (id + pane), not on the text: a keystroke inside the
  // editor must not re-render the grid.
  const docsKey = useEditor((s) =>
    s.docs.map((d) => `${d.id}@${d.groupId ?? ""}:${d.slot}`).join("|"),
  );
  const docsBySlot = useMemo(() => {
    const map = new Map<number, OpenDoc[]>();
    for (const d of useEditor.getState().docs) {
      if (d.groupId !== groupId) continue;
      const list = map.get(d.slot) ?? [];
      list.push(d);
      map.set(d.slot, list);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsKey, groupId]);

  // Browser tabs, sliced the same way. The subscription is on identity +
  // label-relevant fields, so a page navigating (url/title patches) moves the
  // tab's label without re-rendering the grid per keystroke elsewhere.
  const browsersKey = useBrowsers((s) =>
    s.tabs.map((b) => `${b.id}@${b.groupId}:${b.slot}:${b.name ?? ""}:${b.title ?? ""}:${b.url}`).join("|"),
  );
  const browsersBySlot = useMemo(() => {
    const map = new Map<number, PaneBrowser[]>();
    for (const b of useBrowsers.getState().tabs) {
      if (b.groupId !== groupId) continue;
      const list = map.get(b.slot) ?? [];
      list.push(b);
      map.set(b.slot, list);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browsersKey, groupId]);

  // The notebook's tab, when it is docked in this group. A primitive (the
  // slot number or null), so the Zustand selector stays identity-stable.
  const notesSlot = useNotes((s) =>
    s.place.kind === "tab" && s.place.groupId === groupId ? s.place.slot : null,
  );

  const panelCount = useMemo(() => {
    if (layout.mode !== "auto") return layout.panelCount;
    // A pane that holds only an open file, a browser or the notes tab counts
    // as occupied: it is a pane with something in it, and hiding it would
    // hide that thing.
    const occupied = [
      ...new Set([
        ...bySlot.keys(),
        ...docsBySlot.keys(),
        ...browsersBySlot.keys(),
        ...(notesSlot !== null ? [notesSlot] : []),
      ]),
    ].filter(
      (s) =>
        (bySlot.get(s)?.length ?? 0) +
          (docsBySlot.get(s)?.length ?? 0) +
          (browsersBySlot.get(s)?.length ?? 0) +
          (s === notesSlot ? 1 : 0) >
        0,
    );
    const highest = occupied.length ? Math.max(...occupied) + 1 : 1;
    // 1 -> 1, 2 -> 2, 3..4 -> 4 (the automatic grid does not use 3).
    if (highest <= 1) return 1;
    if (highest === 2) return 2;
    return Math.min(6, highest <= 4 ? 4 : 6);
  }, [layout.mode, layout.panelCount, bySlot, docsBySlot, browsersBySlot, notesSlot]);

  /**
   * Where a tab dropped on the "new pane" strip goes.
   *
   * In auto mode it is the first free pane up to six — the grid grows on its
   * own to show it. In a grid pinned by the user, only a pane already on
   * screen counts: sending the tab to a slot beyond the count would make it
   * disappear.
   */
  const newSlot = useMemo(() => {
    const occupied = (s: number) =>
      (bySlot.get(s)?.length ?? 0) +
        (docsBySlot.get(s)?.length ?? 0) +
        (browsersBySlot.get(s)?.length ?? 0) +
        (s === notesSlot ? 1 : 0) >
      0;
    const ceiling = layout.mode === "auto" ? 6 : panelCount;
    for (let i = 0; i < ceiling; i++) if (!occupied(i)) return i;
    return null;
  }, [bySlot, docsBySlot, browsersBySlot, notesSlot, layout.mode, panelCount]);

  // The boundary is per pane, not per grid: a pane that breaks has to leave
  // the other five standing. Before, an exception here wiped the whole
  // window — and, with the tab saved in the workspace, wiped every boot
  // after it too.
  const renderPane = (slot: number) => (
    <ErrorBoundary where={t("este painel")}>
      <TerminalPane
        groupId={groupId}
        slot={slot}
        terminals={bySlot.get(slot) ?? []}
        docs={docsBySlot.get(slot) ?? []}
        browsers={browsersBySlot.get(slot) ?? []}
        notes={notesSlot === slot}
        newSlot={newSlot === slot ? null : newSlot}
        activeId={
          layout.activeBySlot[slot] ??
          bySlot.get(slot)?.[0]?.id ??
          docsBySlot.get(slot)?.[0]?.id ??
          browsersBySlot.get(slot)?.[0]?.id ??
          (notesSlot === slot ? NOTES_TAB_ID : null)
        }
      />
    </ErrorBoundary>
  );

  // The canvas handles its own empty state (you can draw with no terminal
  // at all) and remounts on group switch — the `key` resets camera and selection.
  if (layout.surface === "canvas") {
    return (
      <ErrorBoundary where="o quadro">
        <Suspense fallback={<div className="grid-empty" />}>
          <CanvasView
            key={groupId}
            groupId={groupId}
            terminals={cardTerminals}
            canvas={layout.canvas}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  // A group with no terminal but with a file, a browser or the notes tab
  // open is not empty — the pane below draws it.
  if (
    paneTerminals.length === 0 &&
    docsBySlot.size === 0 &&
    browsersBySlot.size === 0 &&
    notesSlot === null
  ) {
    return (
      <div
        className="grid-empty"
        // The empty group is where people most look for "open something" —
        // and it was the only pane with no menu at all.
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {menu && (
          <ContextMenu
            anchor={menu}
            items={paneMenu(
              { mode: layout.mode, surface: layout.surface, notesHere: false },
              {
                newCli: () =>
                  useUI.getState().openModal("new-terminal", { groupId, slot: 0 }),
                newBrowser: () => useBrowsers.getState().open({ groupId, slot: 0 }),
                dockNotes: () => useNotes.getState().dockTo(groupId, 0),
                setMode: (mode) =>
                  useProjects.getState().updateLayout(groupId, { mode }),
                showSurface: (surface) => show(groupId, surface),
              },
            )}
            onClose={() => setMenu(null)}
          />
        )}
        <div>
          <h2>{t("Nenhum terminal neste grupo")}</h2>
          <p>
            <kbd>Ctrl</kbd> + <kbd>T</kbd> {t("para abrir um shell ou um agente.")}
          </p>
          <div className="pane-empty-actions">
            <button
              className="btn btn--sm"
              onClick={() => useUI.getState().openModal("new-terminal", { groupId, slot: 0 })}
            >
              <Plus size={12} /> {t("Nova aba")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => useBrowsers.getState().open({ groupId, slot: 0 })}
            >
              <Globe size={12} /> {t("Navegador")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (layout.mode === "spotlight" && panelCount > 1) {
    return (
      <PanelGroup direction="horizontal" className="grid" autoSaveId={`${groupId}-spot`}>
        <Panel defaultSize={68} minSize={30}>
          {renderPane(0)}
        </Panel>
        <PanelResizeHandle className="resize-handle resize-handle--v" />
        <Panel defaultSize={32} minSize={15}>
          <PanelGroup direction="vertical">
            {range(1, panelCount).map((slot, i) => (
              <PanelSlot key={slot} first={i === 0}>
                {renderPane(slot)}
              </PanelSlot>
            ))}
          </PanelGroup>
        </Panel>
      </PanelGroup>
    );
  }

  if (panelCount === 1) {
    return <div className="grid">{renderPane(0)}</div>;
  }

  if (panelCount === 2) {
    return (
      <PanelGroup direction="horizontal" className="grid" autoSaveId={`${groupId}-2`}>
        <Panel minSize={15}>{renderPane(0)}</Panel>
        <PanelResizeHandle className="resize-handle resize-handle--v" />
        <Panel minSize={15}>{renderPane(1)}</Panel>
      </PanelGroup>
    );
  }

  if (panelCount === 3) {
    return (
      <PanelGroup direction="horizontal" className="grid" autoSaveId={`${groupId}-3`}>
        <Panel minSize={12}>{renderPane(0)}</Panel>
        <PanelResizeHandle className="resize-handle resize-handle--v" />
        <Panel minSize={12}>{renderPane(1)}</Panel>
        <PanelResizeHandle className="resize-handle resize-handle--v" />
        <Panel minSize={12}>{renderPane(2)}</Panel>
      </PanelGroup>
    );
  }

  // 4, 5 and 6 panes: two rows with 2 or 3 columns.
  const cols = panelCount <= 4 ? 2 : 3;
  const rows = Math.ceil(panelCount / cols);
  return (
    <PanelGroup direction="vertical" className="grid" autoSaveId={`${groupId}-${panelCount}`}>
      {range(0, rows).map((row) => (
        <PanelSlot key={row} first={row === 0}>
          <PanelGroup direction="horizontal">
            {range(0, cols).map((col, i) => {
              const slot = row * cols + col;
              if (slot >= panelCount) return null;
              return (
                <PanelSlot key={slot} first={i === 0} direction="horizontal">
                  {renderPane(slot)}
                </PanelSlot>
              );
            })}
          </PanelGroup>
        </PanelSlot>
      ))}
    </PanelGroup>
  );
}

/** Pane with the divider that precedes it, so the `map`s above stay clean. */
function PanelSlot({
  children,
  first,
  direction = "vertical",
}: {
  children: React.ReactNode;
  first: boolean;
  direction?: "vertical" | "horizontal";
}) {
  return (
    <>
      {!first && (
        <PanelResizeHandle
          className={`resize-handle ${
            direction === "horizontal" ? "resize-handle--v" : "resize-handle--h"
          }`}
        />
      )}
      <Panel minSize={10}>{children}</Panel>
    </>
  );
}

