/**
 * The pane grid.
 *
 * By default there is **a single pane**, filling the whole screen: a new
 * terminal is born in slot 0 and becomes another tab. The screen only
 * splits when the user drags a tab onto another pane (or pins a grid on
 * the title bar).
 *
 * Three modes (§F2):
 *
 * - **auto**: the pane count follows the number of occupied slots (1/2/4);
 * - **grid**: the user pins 1–6 panes;
 * - **spotlight**: one large pane and the rest in a column beside it.
 *
 * The dividers are `react-resizable-panels`; each pane's size is session
 * state, not workspace state — what persists is the mode and the count.
 */
import { lazy, Suspense, useMemo } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { FloorsControl } from "../Floors";
import { TerminalPane } from "../TerminalPane";
import { range } from "../../lib/format";
import { parseLayout, useProjects } from "../../stores/projectsStore";
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
  const mode = useProjects((s) => s.layoutOf(groupId).mode);
  return (
    <>
      <GridBody groupId={groupId} />
      <FloorsControl
        groupId={groupId}
        variant={mode === "canvas" ? "canvas" : "grid"}
      />
    </>
  );
}

function GridBody({ groupId }: Props) {
  // The selector returns the store's raw reference. Filtering inside it
  // would create a new array on every call, and since Zustand compares by
  // identity that becomes "Maximum update depth exceeded" — the render
  // feeds itself. Every list slice goes into `useMemo`.
  const allTerminals = useProjects((s) => s.terminals);
  const groups = useProjects((s) => s.groups);
  const moveTerminal = useProjects((s) => s.moveTerminal);

  const terminals = useMemo(
    () => allTerminals.filter((t) => t.groupId === groupId),
    [allTerminals, groupId],
  );

  const layout = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return parseLayout(g?.layoutJson ?? "");
  }, [groups, groupId]);

  const bySlot = useMemo(() => {
    const map = new Map<number, TerminalRow[]>();
    for (const t of terminals) {
      const list = map.get(t.slot) ?? [];
      list.push(t);
      map.set(t.slot, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sort - b.sort);
    return map;
  }, [terminals]);

  const panelCount = useMemo(() => {
    if (layout.mode !== "auto") return layout.panelCount;
    const occupied = [...bySlot.keys()].filter(
      (s) => (bySlot.get(s)?.length ?? 0) > 0,
    );
    const highest = occupied.length ? Math.max(...occupied) + 1 : 1;
    // 1 -> 1, 2 -> 2, 3..4 -> 4 (the automatic grid does not use 3).
    if (highest <= 1) return 1;
    if (highest === 2) return 2;
    return Math.min(6, highest <= 4 ? 4 : 6);
  }, [layout.mode, layout.panelCount, bySlot]);

  const renderPane = (slot: number) => (
    <TerminalPane
      groupId={groupId}
      slot={slot}
      terminals={bySlot.get(slot) ?? []}
      activeId={layout.activeBySlot[slot] ?? bySlot.get(slot)?.[0]?.id ?? null}
      onDropTerminal={(id) => moveTerminal(id, slot)}
    />
  );

  // The canvas handles its own empty state (you can draw with no terminal
  // at all) and remounts on group switch — the `key` resets camera and selection.
  if (layout.mode === "canvas") {
    return (
      <Suspense fallback={<div className="grid-empty" />}>
        <CanvasView
          key={groupId}
          groupId={groupId}
          terminals={terminals}
          canvas={layout.canvas}
        />
      </Suspense>
    );
  }

  if (terminals.length === 0) {
    return (
      <div className="grid-empty">
        <div>
          <h2>Nenhum terminal neste grupo</h2>
          <p>
            <kbd>Ctrl</kbd> + <kbd>T</kbd> para abrir um shell ou um agente.
          </p>
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

