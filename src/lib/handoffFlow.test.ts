/**
 * The notice after a handoff is a key into the English dictionary. One
 * character of drift between the source and the dictionary line and the
 * English user reads the Portuguese sentence, with the gap recorded as a
 * missing key nobody sees.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  ipc: {
    listAgentSessions: vi.fn(async () => []),
    sessionEvents: vi.fn(async () => []),
    readPrefs: vi.fn(async () => ({})),
    writePref: vi.fn(async () => undefined),
  },
}));
vi.mock("./log", () => ({
  uiLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { openHandoffFor } from "./handoffFlow";
import { setActiveLang } from "./i18n";
import { useProjects } from "../stores/projectsStore";
import { useUI } from "../stores/uiStore";

beforeEach(() => {
  useProjects.setState({
    loaded: false,
    projects: [],
    groups: [{ id: "g1", projectId: null, name: "Board", layoutJson: "{}", suspended: false, sort: 0 }],
    terminals: [{ id: "t1", groupId: "g1", slot: 0, kind: "agent", title: "claude", program: "claude", args: [], cwd: "C:/proj", sort: 0, alive: true, createdAt: 0 }],
    activeProjectId: null,
    activeGroupId: "g1",
  });
  useUI.setState({ toasts: [] });
  setActiveLang("en");
});

afterEach(() => setActiveLang("pt-BR"));

/** The regression: the source string and the dictionary key disagreed on one punctuation mark. */
it("tells the English user, in English, that the baton is in the composer", async () => {
  await openHandoffFor("t1");
  expect(useUI.getState().toasts.map((t) => t.message)).toEqual([
    "Baton assembled from claude, pick who takes over and read it before sending.",
  ]);
});
