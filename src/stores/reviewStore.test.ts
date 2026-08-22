/**
 * Annotations survive a reload, so what comes back from `kv` has to be
 * checked — and an emptied comment has to be understood as a deletion.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { byAnchor, parseComments, useReview } from "./reviewStore";
import type { ReviewComment } from "../lib/review";

const base = {
  projectId: "p1",
  root: "C:\\proj",
  path: "src/a.ts",
  line: 10,
  onOld: false,
  code: "const x = 1;",
  body: "sai do laço",
};

beforeEach(() => {
  useReview.setState({ comments: [] });
});

describe("parseComments", () => {
  it("returns nothing for junk", () => {
    expect(parseComments(undefined)).toEqual([]);
    expect(parseComments("não é json")).toEqual([]);
    expect(parseComments('{"nope":1}')).toEqual([]);
  });

  it("drops rows missing what a comment needs and keeps the rest", () => {
    const raw = JSON.stringify([
      { id: "1", projectId: "p", path: "a.ts", body: "ok" },
      { id: "2", projectId: "p", path: "a.ts", body: "   " },
      { id: "3", path: "a.ts", body: "sem projeto" },
      { projectId: "p", path: "a.ts", body: "sem id" },
    ]);
    expect(parseComments(raw).map((c) => c.id)).toEqual(["1"]);
  });

  it("fills in the optional fields with safe defaults", () => {
    const [row] = parseComments(
      JSON.stringify([{ id: "1", projectId: "p", path: "a.ts", body: "ok" }]),
    );
    expect(row).toMatchObject({ line: null, onOld: false, code: "", createdAt: 0 });
  });

  it("refuses a line number that is not a number", () => {
    const [row] = parseComments(
      JSON.stringify([
        { id: "1", projectId: "p", path: "a.ts", body: "ok", line: "12" },
      ]),
    );
    expect(row.line).toBeNull();
  });
});

describe("useReview", () => {
  it("adds and finds by worktree and by file", () => {
    const store = useReview.getState();
    store.add(base);
    store.add({ ...base, path: "src/b.ts" });
    store.add({ ...base, projectId: "p2" });
    expect(useReview.getState().ofScope("p1", "C:\\proj")).toHaveLength(2);
    expect(useReview.getState().ofFile("p1", "C:\\proj", "src/a.ts")).toHaveLength(1);
  });

  /**
   * A floor is the same project with its own `src/a.ts`. An annotation
   * written there must not show up glued to the same line on the ground —
   * nor vanish when the ground is sent.
   */
  it("does not mix the ground's annotations with the floor's", () => {
    const store = useReview.getState();
    store.add(base);
    store.add({ ...base, root: "C:\\proj\\.yard\\floors\\api" });

    expect(useReview.getState().ofFile("p1", "C:\\proj", "src/a.ts")).toHaveLength(1);
    expect(
      useReview.getState().ofFile("p1", "C:\\proj\\.yard\\floors\\api", "src/a.ts"),
    ).toHaveLength(1);

    useReview.getState().clearScope("p1", "C:\\proj");
    expect(useReview.getState().comments.map((c) => c.root)).toEqual([
      "C:\\proj\\.yard\\floors\\api",
    ]);
  });

  /** The root is compared like everywhere else in the app: separator and case do not count. */
  it("recognises the same root spelled another way", () => {
    useReview.getState().add(base);
    expect(useReview.getState().ofScope("p1", "c:/proj")).toHaveLength(1);
  });

  /** Rows written before the `root` field still count for the project. */
  it("an old annotation, with no root, still shows up in any worktree", () => {
    useReview.setState({
      comments: parseComments(
        JSON.stringify([{ id: "1", projectId: "p1", path: "src/a.ts", body: "antiga" }]),
      ),
    });
    expect(useReview.getState().ofScope("p1", "C:\\proj")).toHaveLength(1);
    expect(useReview.getState().ofScope("p1", "D:\outro")).toHaveLength(1);
  });

  it("treats an emptied body as a deletion", () => {
    const id = useReview.getState().add(base)!;
    useReview.getState().edit(id, "   ");
    expect(useReview.getState().comments).toHaveLength(0);
  });

  it("trims an edited body", () => {
    const id = useReview.getState().add(base)!;
    useReview.getState().edit(id, "  outro texto  ");
    expect(useReview.getState().comments[0].body).toBe("outro texto");
  });

  it("clears one project without touching the others", () => {
    const store = useReview.getState();
    store.add(base);
    store.add({ ...base, projectId: "p2" });
    useReview.getState().clearProject("p1");
    expect(useReview.getState().comments.map((c) => c.projectId)).toEqual(["p2"]);
  });

  /**
   * The cap used to be global and silently cut the oldest annotation: a big
   * review in one project ate another project's annotations.
   */
  it("at the cap, refuses the new one instead of deleting the first", () => {
    const store = useReview.getState();
    for (let i = 0; i < 400; i++) store.add({ ...base, body: `nota ${i}` });
    expect(useReview.getState().add({ ...base, body: "a 401" })).toBeNull();
    expect(useReview.getState().comments).toHaveLength(400);
    expect(useReview.getState().comments[0].body).toBe("nota 0");
    // The cap is per worktree: another floor can still annotate.
    expect(
      useReview.getState().add({ ...base, root: "C:\\proj\\.yard\\floors\\api" }),
    ).not.toBeNull();
  });
});

describe("byAnchor", () => {
  const row = (patch: Partial<ReviewComment>): ReviewComment => ({
    id: "x",
    createdAt: 0,
    ...base,
    ...patch,
  });

  it("keeps the two sides of a line apart", () => {
    const map = byAnchor([
      row({ id: "a", line: 10, onOld: false }),
      row({ id: "b", line: 10, onOld: true }),
    ]);
    expect(map.get("n10")?.map((c) => c.id)).toEqual(["a"]);
    expect(map.get("o10")?.map((c) => c.id)).toEqual(["b"]);
  });

  it("stacks several comments on the same line", () => {
    const map = byAnchor([row({ id: "a" }), row({ id: "b" })]);
    expect(map.get("n10")).toHaveLength(2);
  });
});

/**
 * Sending is the one action in the app that destroys work when it succeeds:
 * the annotations vanish and what remains is the message in the agent's
 * scrollback.
 *
 * The regression this locks: the cleanup was by scope (project + worktree),
 * but the text sent is what was captured **before** `injectAndConfirm`, which
 * waits up to 6 s for the confirmation. An annotation written in that window
 * was deleted without ever having been sent.
 */
describe("clearing after sending", () => {
  it("deletes only what was sent", () => {
    const a = useReview.getState().add({ ...base, body: "primeira" })!;
    const b = useReview.getState().add({ ...base, body: "segunda" })!;
    // The send takes these two; while it confirms, the user writes one more.
    const sent = [a, b];
    const c = useReview.getState().add({ ...base, body: "escrita durante o envio" })!;

    useReview.getState().removeMany(sent);

    const remaining = useReview.getState().comments;
    expect(remaining.map((x) => x.id)).toEqual([c]);
    expect(remaining[0].body).toBe("escrita durante o envio");
  });

  it("ids that no longer exist do not get in the way", () => {
    const a = useReview.getState().add({ ...base, body: "única" })!;
    useReview.getState().removeMany([a, "fantasma"]);
    expect(useReview.getState().comments).toEqual([]);
  });
});
