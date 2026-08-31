/**
 * One pane's bar, read from the stores.
 *
 * `lib/paneBar.ts` decides the order out of plain data; this is the door that
 * fetches that data. Three callers need it and none of them can build it on
 * its own: the keyboard (Ctrl+Tab walks the bar), the drag (a drop has to know
 * what the target bar holds to write the new one), and the tab menus (whether
 * "one place to the left" has anywhere to go).
 *
 * `TerminalPane` is the exception and stays out: it already receives its rows
 * as props and has to re-render when they change, so it calls `barOrder`
 * itself. A snapshot read through `getState()` would paint a stale bar.
 */
import { barOrder, type TabRef } from "./paneBar";
import { useBrowsers } from "../stores/browsersStore";
import { useEditor } from "../stores/editorStore";
import { NOTES_TAB_ID, useNotes } from "../stores/notesStore";
import { useProjects } from "../stores/projectsStore";

/** Every tab of one pane, in the order the bar paints them. */
export function paneTabs(groupId: string, slot: number): TabRef[] {
  const place = useNotes.getState().place;
  return barOrder({
    groupId,
    slot,
    // A bar only ever paints the grid's CLIs: the board's cards are not tabs.
    terminals: useProjects.getState().terminalsOn(groupId, "grid"),
    docs: useEditor.getState().docs,
    browsers: useBrowsers.getState().tabs,
    notesId:
      place.kind === "tab" && place.groupId === groupId && place.slot === slot
        ? NOTES_TAB_ID
        : null,
    order: useProjects.getState().layoutOf(groupId).tabOrder?.[slot],
  });
}

/** Saves a bar the user just rearranged, as the ids it now holds. */
export function saveBar(groupId: string, slot: number, tabs: readonly TabRef[]): void {
  useProjects.getState().setTabOrder(
    groupId,
    slot,
    tabs.map((t) => t.id),
  );
}
