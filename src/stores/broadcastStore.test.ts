/**
 * Broadcast is armed per group and lives only in memory. The rules here are
 * what keeps it from becoming a footgun: one group at a time (two groups
 * broadcasting would spray the same keystroke across the workspace), and a
 * group that leaves the workspace takes the mode down with it — a stale id
 * would be "on" for nobody, with the shortcut toggling it off and on forever.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { GroupRow } from "../lib/ipc";
import { useBroadcast } from "./broadcastStore";
import { useProjects } from "./projectsStore";

function group(id: string): GroupRow {
  return { id, projectId: "p1", name: id, layoutJson: "{}", suspended: false, sort: 0 };
}

beforeEach(() => {
  useProjects.setState({ groups: [group("g1"), group("g2")] });
  useBroadcast.getState().off();
});

describe("broadcastStore", () => {
  it("starts off, and toggling arms exactly the given group", () => {
    expect(useBroadcast.getState().isOn("g1")).toBe(false);
    useBroadcast.getState().toggle("g1");
    expect(useBroadcast.getState().isOn("g1")).toBe(true);
    expect(useBroadcast.getState().isOn("g2")).toBe(false);
  });

  it("toggling the armed group again disarms it", () => {
    useBroadcast.getState().toggle("g1");
    useBroadcast.getState().toggle("g1");
    expect(useBroadcast.getState().groupId).toBeNull();
  });

  it("toggling another group moves the mode there — never two groups at once", () => {
    useBroadcast.getState().toggle("g1");
    useBroadcast.getState().toggle("g2");
    expect(useBroadcast.getState().isOn("g1")).toBe(false);
    expect(useBroadcast.getState().isOn("g2")).toBe(true);
  });

  it("goes off on its own when the armed group leaves the workspace", () => {
    useBroadcast.getState().toggle("g1");
    useProjects.setState({ groups: [group("g2")] });
    expect(useBroadcast.getState().groupId).toBeNull();
  });

  it("survives a groups change that keeps the armed group", () => {
    useBroadcast.getState().toggle("g1");
    useProjects.setState({ groups: [group("g1")] });
    expect(useBroadcast.getState().isOn("g1")).toBe(true);
  });
});
