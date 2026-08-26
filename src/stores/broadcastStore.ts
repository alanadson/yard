/**
 * Which group (if any) is broadcasting its keyboard — see `lib/broadcast.ts`.
 *
 * In memory only, never in `kv`: a broadcast that came back on at boot would
 * type into terminals nobody was looking at. One group at a time, and the
 * mode follows the group out of the workspace (a floor closed, a group
 * deleted) instead of staying armed for an id that no longer exists.
 */
import { create } from "zustand";

import { useProjects } from "./projectsStore";

interface BroadcastState {
  /** The armed group, or `null` while off. */
  groupId: string | null;
  /** Arms the group; arms the other one when it moves; disarms when it is the armed one. */
  toggle: (groupId: string) => void;
  off: () => void;
  isOn: (groupId: string) => boolean;
  /** Disarms when the armed group is gone. Called on every groups change. */
  prune: () => void;
}

export const useBroadcast = create<BroadcastState>((set, get) => ({
  groupId: null,

  toggle: (groupId) => set({ groupId: get().groupId === groupId ? null : groupId }),

  off: () => set({ groupId: null }),

  isOn: (groupId) => get().groupId === groupId,

  prune: () => {
    const armed = get().groupId;
    if (!armed) return;
    if (!useProjects.getState().groups.some((g) => g.id === armed)) set({ groupId: null });
  },
}));

// A subscription rather than a call at every place a group can vanish
// (delete, close floor, prune at boot): the one that forgets is the one that
// leaves the shortcut toggling a ghost.
useProjects.subscribe((state, prev) => {
  if (state.groups !== prev.groups) useBroadcast.getState().prune();
});
