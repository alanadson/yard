/**
 * The state of the Source Control tab. What this store has to get right is
 * not holding data — it is what happens **around** every write operation on
 * the repository:
 *
 * - every operation that changes the repository has to reload what is on
 *   screen, or the list keeps showing the world as it was before the click
 *   (and the next click acts on a row that no longer exists);
 * - an operation that fails must not leave the panel stuck on "busy" — that
 *   is the state in which no button responds and nothing explains why;
 * - the message draft is **per repository**. Switching projects mid-sentence
 *   and coming back has to bring the sentence back; writing in project A and
 *   committing in B would be worse than losing the text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  scmInfo: vi.fn(),
  scmBranches: vi.fn(),
  scmStashList: vi.fn(),
  scmTags: vi.fn(),
  scmLog: vi.fn(),
  scmStage: vi.fn(),
  scmCommit: vi.fn(),
  scmDiscard: vi.fn(),
  writePref: vi.fn(),
  readPrefs: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    scmInfo: calls.scmInfo,
    scmBranches: calls.scmBranches,
    scmStashList: calls.scmStashList,
    scmTags: calls.scmTags,
    scmLog: calls.scmLog,
    scmStage: calls.scmStage,
    scmCommit: calls.scmCommit,
    scmDiscard: calls.scmDiscard,
    writePref: calls.writePref,
    readPrefs: calls.readPrefs,
  },
}));

import { useScm, type ScmRepo } from "./scmStore";

const INFO = {
  isRepo: true,
  root: "C:/proj",
  branch: "main",
  head: "abc1234",
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [],
  state: "clean" as const,
  stashes: 0,
  hasHead: true,
};

function reset() {
  useScm.setState({ root: null, projectId: null, byRoot: {}, drafts: {} });
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.scmInfo.mockResolvedValue(INFO);
  calls.scmBranches.mockResolvedValue([]);
  calls.scmStashList.mockResolvedValue([]);
  calls.scmTags.mockResolvedValue([]);
  calls.scmLog.mockResolvedValue([]);
  calls.scmStage.mockResolvedValue(undefined);
  calls.scmDiscard.mockResolvedValue(undefined);
  calls.scmCommit.mockResolvedValue({
    hash: "f".repeat(40),
    short: "fffffff",
    subject: "feito",
    files: 1,
    additions: 2,
    deletions: 0,
  });
}

const repo = (root = "C:/proj"): ScmRepo | undefined =>
  useScm.getState().byRoot[root.toLowerCase()];

describe("useScm.refresh", () => {
  beforeEach(reset);

  it("stores what the backend answered under the root that was asked", async () => {
    await useScm.getState().refresh("C:/proj");
    expect(calls.scmInfo).toHaveBeenCalledWith("C:/proj");
    expect(repo()?.info?.branch).toBe("main");
  });

  it("two roots coexist — one's answer does not overwrite the other's", async () => {
    await useScm.getState().refresh("C:/proj");
    calls.scmInfo.mockResolvedValue({ ...INFO, branch: "outra" });
    await useScm.getState().refresh("C:/outro");
    expect(repo("C:/proj")?.info?.branch).toBe("main");
    expect(repo("C:/outro")?.info?.branch).toBe("outra");
  });

  it("the same root spelled with different slashes is the same root", async () => {
    await useScm.getState().refresh("C:/proj");
    await useScm.getState().refresh("C:\\proj\\");
    expect(Object.keys(useScm.getState().byRoot).length).toBe(1);
  });

  it("a backend error does not leave the panel 'loading' forever", async () => {
    calls.scmInfo.mockRejectedValue("git sumiu");
    await useScm.getState().refresh("C:/proj");
    expect(repo()?.loading).toBe(false);
    expect(repo()?.error).toContain("git sumiu");
  });

  it("a refresh that succeeds clears the previous one's error", async () => {
    calls.scmInfo.mockRejectedValue("falhou");
    await useScm.getState().refresh("C:/proj");
    calls.scmInfo.mockResolvedValue(INFO);
    await useScm.getState().refresh("C:/proj");
    expect(repo()?.error).toBeNull();
  });
});

/**
 * The cost of a `refresh`.
 *
 * On Windows, spawning a `git` costs ~35 ms **before** it does anything at
 * all. `refresh` asked for four things at once — header, branches, stashes,
 * tags — and three of them feed sections that are not on screen. Since every
 * write ends in `refresh`, and the watcher fires another every time
 * `git status` moves, that was ~110 ms of process thrown away per click and
 * per keystroke of an agent. Now each section pays only for what it draws.
 */
describe("useScm.refresh — what each section costs", () => {
  beforeEach(reset);

  it("in the Changes section fetches neither branches, tags nor stashes", async () => {
    useScm.setState({ section: "changes" });
    await useScm.getState().refresh("C:/proj");
    expect(calls.scmInfo).toHaveBeenCalledTimes(1);
    expect(calls.scmBranches).not.toHaveBeenCalled();
    expect(calls.scmTags).not.toHaveBeenCalled();
    expect(calls.scmStashList).not.toHaveBeenCalled();
  });

  it("in the Branches section fetches branches and tags — which is what it draws", async () => {
    useScm.setState({ section: "branches" });
    await useScm.getState().refresh("C:/proj");
    expect(calls.scmBranches).toHaveBeenCalledWith("C:/proj");
    expect(calls.scmTags).toHaveBeenCalledWith("C:/proj");
    expect(calls.scmStashList).not.toHaveBeenCalled();
  });

  it("in the Stash section fetches the stash pile, and only that", async () => {
    useScm.setState({ section: "stash" });
    await useScm.getState().refresh("C:/proj");
    expect(calls.scmStashList).toHaveBeenCalledWith("C:/proj");
    expect(calls.scmBranches).not.toHaveBeenCalled();
  });

  it("switching to a section loads what it needs — otherwise it opens empty", async () => {
    useScm.setState({ section: "changes", root: "C:/proj", projectId: "p1" });
    useScm.getState().setSection("branches");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.scmBranches).toHaveBeenCalledWith("C:/proj");
  });
});

describe("useScm.run", () => {
  beforeEach(reset);

  it("every operation reloads the state when it finishes — the list does not stay in the past", async () => {
    useScm.getState().setRepo("p1", "C:/proj");
    calls.scmInfo.mockClear();
    await useScm.getState().run("C:/proj", "preparar", () =>
      calls.scmStage("C:/proj", ["a.ts"]),
    );
    expect(calls.scmStage).toHaveBeenCalled();
    expect(calls.scmInfo).toHaveBeenCalled();
  });

  it("while it runs, the panel knows the name of what is running", async () => {
    let release: (() => void) | null = null;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const task = useScm.getState().run("C:/proj", "enviando", () => wait);
    expect(repo()?.busy).toBe("enviando");
    release!();
    await task;
    expect(repo()?.busy).toBeNull();
  });

  it("an operation that fails returns the error and unlocks the panel", async () => {
    const err = await useScm
      .getState()
      .run("C:/proj", "preparar", () => Promise.reject("o git recusou"));
    expect(err).toContain("o git recusou");
    expect(repo()?.busy).toBeNull();
  });

  /**
   * The counter that says "the repository moved".
   *
   * The diff open on a row cannot steer by the `git status` summary: staging
   * the **second** hunk of a file that was already `MM` changes neither path,
   * verb, side nor count — nothing a fingerprint of the summary can see. And
   * the diff did change: the hunk that just went to the index left it.
   * Without this counter, the next click builds a patch from a text that no
   * longer exists, and `git apply` refuses.
   */
  it("every successful write advances the repository version", async () => {
    const before = repo()?.version ?? 0;
    await useScm.getState().run("C:/proj", "preparar", () => Promise.resolve());
    const after = repo()!.version;
    expect(after).toBeGreaterThan(before);

    await useScm.getState().run("C:/proj", "preparar", () => Promise.resolve());
    expect(repo()!.version).toBeGreaterThan(after);
  });

  it("a write that fails does not advance the version — nothing moved in the repository", async () => {
    await useScm.getState().run("C:/proj", "preparar", () => Promise.resolve());
    const after = repo()!.version;
    await useScm.getState().run("C:/proj", "preparar", () => Promise.reject("recusou"));
    expect(repo()!.version).toBe(after);
  });

  it("an operation that succeeds returns no error at all", async () => {
    expect(
      await useScm.getState().run("C:/proj", "preparar", () => Promise.resolve()),
    ).toBeNull();
  });
});

describe("message draft", () => {
  beforeEach(reset);

  it("is per repository: writing in one does not leak into the other", () => {
    const { setDraft } = useScm.getState();
    setDraft("C:/proj", "corrige o merge");
    setDraft("C:/outro", "outra coisa");
    expect(useScm.getState().draftOf("C:/proj")).toBe("corrige o merge");
    expect(useScm.getState().draftOf("C:/outro")).toBe("outra coisa");
  });

  it("a repository with no draft starts blank, not `undefined`", () => {
    expect(useScm.getState().draftOf("C:/nunca-visto")).toBe("");
    expect(useScm.getState().draftOf(null)).toBe("");
  });

  it("the commit clears that repository's draft — and only that one", async () => {
    const s = useScm.getState();
    s.setDraft("C:/proj", "mensagem");
    s.setDraft("C:/outro", "intacta");
    await s.commit("C:/proj", { stageAll: false });
    expect(calls.scmCommit).toHaveBeenCalledWith("C:/proj", "mensagem", {
      stageAll: false,
    });
    expect(useScm.getState().draftOf("C:/proj")).toBe("");
    expect(useScm.getState().draftOf("C:/outro")).toBe("intacta");
  });

  it("a commit that fails preserves the text — retyping the message would be the wrong punishment", async () => {
    calls.scmCommit.mockRejectedValue("hook recusou");
    const s = useScm.getState();
    s.setDraft("C:/proj", "mensagem cara");
    const error = await s.commit("C:/proj", {});
    expect(error).toContain("hook recusou");
    expect(useScm.getState().draftOf("C:/proj")).toBe("mensagem cara");
  });

  it("committing without a message never even calls git", async () => {
    const s = useScm.getState();
    s.setDraft("C:/proj", "   ");
    expect(await s.commit("C:/proj", {})).toContain("mensagem");
    expect(calls.scmCommit).not.toHaveBeenCalled();
  });
});

describe("paginated history", () => {
  beforeEach(reset);

  it("the first page replaces and the next one appends at the end", async () => {
    const commit = (hash: string) => ({
      hash,
      short: hash.slice(0, 7),
      author: "a",
      email: "a@x",
      date: 1,
      parents: [],
      refs: [],
      subject: hash,
      body: "",
    });
    calls.scmLog.mockResolvedValue([commit("aaa"), commit("bbb")]);
    await useScm.getState().loadLog("C:/proj", false);
    expect(repo()?.commits.map((c) => c.hash)).toEqual(["aaa", "bbb"]);

    calls.scmLog.mockResolvedValue([commit("ccc")]);
    await useScm.getState().loadLog("C:/proj", true);
    expect(repo()?.commits.map((c) => c.hash)).toEqual(["aaa", "bbb", "ccc"]);
    // The second page asks skipping what already came.
    expect(calls.scmLog).toHaveBeenLastCalledWith(
      "C:/proj",
      expect.objectContaining({ skip: 2 }),
    );
  });

  /**
   * "History of this file" is the same list, filtered — and it is a closed
   * list: asking for "more" with the filter lost would bring the whole
   * repository's history on top of the file's.
   */
  it("a file's history replaces the list and arrives already closed", async () => {
    calls.scmLog.mockResolvedValue([
      {
        hash: "aaa",
        short: "aaa",
        author: "a",
        email: "a@x",
        date: 1,
        parents: [],
        refs: [],
        subject: "mexeu no arquivo",
        body: "",
      },
    ]);
    await useScm.getState().loadFileLog("C:/proj", "src/a.ts");
    expect(calls.scmLog).toHaveBeenCalledWith(
      "C:/proj",
      expect.objectContaining({ path: "src/a.ts" }),
    );
    expect(repo()?.commits.map((c) => c.subject)).toEqual(["mexeu no arquivo"]);
    expect(repo()?.logDone).toBe(true);
  });

  it("a page smaller than requested is the end of the list — the 'more' button goes away", async () => {
    calls.scmLog.mockResolvedValue([]);
    await useScm.getState().loadLog("C:/proj", false);
    expect(repo()?.logDone).toBe(true);
  });
});
