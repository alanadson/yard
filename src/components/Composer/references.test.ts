/** References must respect the same connection boundaries as the agent CLI. */
import { describe, expect, it } from "vitest";
import { EMPTY_CANVAS, type CanvasItem } from "../../lib/canvas";
import { makeCtx } from "../../lib/bridgeCore";
import type { TerminalRow } from "../../lib/ipc";
import {
  composerMentions,
  composerReferences,
  referenceText,
  referenceQuery,
  fileReferences,
} from "./references";

it("does not send live note references to an agent named note", () => {
  const noteReference = referenceText({
    id: "n1",
    kind: "note",
    name: "Brief",
  });
  expect(
    composerMentions(`${noteReference} @Reviewer`, ["note", "Reviewer"]),
  ).toEqual(["Reviewer"]);
});

function terminal(id: string): TerminalRow {
  return {
    id,
    groupId: "board",
    slot: 0,
    title: id,
    kind: "agent",
    agentId: "claude",
    program: "claude",
    args: [],
    cwd: "C:/project",
    resume: null,
    sort: 0,
    alive: true,
    createdAt: 1000,
  };
}
function note(id: string): CanvasItem {
  return {
    id,
    type: "note",
    name: id,
    text: "Live content",
    x: 0,
    y: 0,
    w: 200,
    h: 150,
    color: "#fff",
  };
}
function wire(from: string, to: string): CanvasItem {
  return { id: `${from}-${to}`, type: "connection", from, to, color: "#fff" };
}

describe("canvas references", () => {
  it("finds files by an accent-insensitive path and quotes paths containing spaces", () => {
    const files = fileReferences(
      "C:\\My Project",
      ["src/config.ts", "docs/Visão geral.md"],
      "visao",
    );
    expect(files.map((file) => file.name)).toEqual(["docs/Visão geral.md"]);
    expect(referenceText(files[0])).toBe('"C:/My Project/docs/Visão geral.md"');
  });
  it("opens file search at a hash word boundary and ignores hashes inside a URL", () => {
    expect(referenceQuery("Review #src/view", 16)).toEqual({
      trigger: "#",
      query: "src/view",
      at: 7,
    });
    expect(referenceQuery("https://example.com/#src", 24)).toBeNull();
  });
  it("addresses a live note by its stable id without copying its current contents", () => {
    expect(referenceText({ id: "brief-id", kind: "note", name: "Brief" })).toBe(
      '@note("Brief", id="brief-id")',
    );
  });
  it("offers connected notes and portals without exposing a teammate's private notes", () => {
    const me = terminal("Writer");
    const peer = terminal("Reviewer");
    const ctx = makeCtx(
      me,
      "board",
      {
        ...EMPTY_CANVAS,
        items: [
          note("Brief"),
          note("Details"),
          note("Private"),
          {
            id: "preview",
            type: "portal",
            name: "Preview",
            url: "http://localhost:3000",
            x: 0,
            y: 0,
            w: 700,
            h: 500,
            color: "#fff",
          },
          wire(me.id, peer.id),
          wire(me.id, "Brief"),
          wire("Brief", "Details"),
          wire("Details", "preview"),
          wire(peer.id, "Private"),
        ],
      },
      [me, peer],
    );
    expect(
      composerReferences(ctx).map(({ kind, name }) => ({ kind, name })),
    ).toEqual([
      { kind: "agent", name: "Reviewer" },
      { kind: "note", name: "Brief" },
      { kind: "note", name: "Details" },
      { kind: "portal", name: "Preview" },
    ]);
  });
});
