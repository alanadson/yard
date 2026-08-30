/**
 * The HEAD-text cache behind the git calha.
 *
 * One entry per open document, holding the whole file as git has it. The
 * regression this locks down: the cache used to be pruned by walking the
 * *state* cache's keys, so a document whose editor state had already been
 * evicted (forty files is the ceiling) left its HEAD text behind forever,
 * the tab was closed, the copy of the file was not.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { gitHeadText } = vi.hoisted(() => ({ gitHeadText: vi.fn() }));

vi.mock("../../lib/ipc", () => ({ ipc: { gitHeadText } }));

import { cachedHeadText, dropHeadText, headTextFor, keepHeadText } from "./gitGutter";

const doc = (id: string) => ({ id, root: "C:/r", path: `${id}.ts` });

describe("the HEAD-text cache", () => {
  beforeEach(() => {
    gitHeadText.mockReset();
    gitHeadText.mockImplementation((_root: string, path: string) =>
      Promise.resolve(`head of ${path}`),
    );
    keepHeadText(new Set());
  });

  it("asks git once per disk version and answers the rest from memory", async () => {
    await headTextFor(doc("a"), "v1");
    await headTextFor(doc("a"), "v1");

    expect(gitHeadText).toHaveBeenCalledTimes(1);
    expect(cachedHeadText("a")).toBe("head of a.ts");
  });

  it("re-asks git when the file changed on disk", async () => {
    await headTextFor(doc("a"), "v1");
    await headTextFor(doc("a"), "v2");

    expect(gitHeadText).toHaveBeenCalledTimes(2);
  });

  it("forgets every document that is no longer open", async () => {
    await headTextFor(doc("a"), "v1");
    await headTextFor(doc("b"), "v1");
    await headTextFor(doc("c"), "v1");

    keepHeadText(new Set(["a", "c"]));

    expect(cachedHeadText("b")).toBeUndefined();
    expect(cachedHeadText("a")).toBe("head of a.ts");
    expect(cachedHeadText("c")).toBe("head of c.ts");
  });

  it("drops one document on request", async () => {
    await headTextFor(doc("a"), "v1");
    dropHeadText("a");

    expect(cachedHeadText("a")).toBeUndefined();
  });
});
