/**
 * The copy of the irreversible warnings in the Source Control tab.
 *
 * They live outside the JSX for the usual reason — plurals, counts, and the
 * exact name of what goes away — but here there is one more: **a vague
 * warning is worse than none**. "Are you sure?" teaches people to click "Yes"
 * without reading; a warning that says *what*, *how many* and *what does not
 * come back* is the only one still being read on the fifth use.
 *
 * The rule these tests lock in: every warning names its target, and every
 * warning about something that does not come back says so.
 */
import { describe, expect, it } from "vitest";

import {
  branchDeleteSpec,
  discardAllSpec,
  discardSpec,
  remoteDeleteSpec,
  resetSpec,
  stashDropSpec,
} from "./scmConfirm";

describe("discardSpec", () => {
  it("one tracked file: names the file and says what it turns into", () => {
    const s = discardSpec(["src/lib/a.ts"], false);
    expect(s.title).toContain("src/lib/a.ts");
    expect(s.detail).toContain("último commit");
    expect(s.confirmLabel).toBe("Descartar");
  });

  it("a new file is a deletion, and the copy uses that word", () => {
    const s = discardSpec(["gerado.txt"], true);
    expect(s.title).toContain("gerado.txt");
    expect(s.detail).toContain("apagado do disco");
    expect(s.confirmLabel).toBe("Excluir");
  });

  it("several files are counted, not listed one by one in a title", () => {
    const s = discardSpec(["a.ts", "b.ts", "c.ts"], false);
    expect(s.title).toContain("3 arquivos");
    expect(s.title).not.toContain("a.ts");
  });

  it("every warning says it cannot be undone", () => {
    expect(discardSpec(["a.ts"], false).detail).toContain("não dá para desfazer");
    expect(discardSpec(["a.ts"], true).detail).toContain("não dá para desfazer");
  });
});

describe("discardAllSpec", () => {
  it("separates what goes back to the commit from what vanishes from disk", () => {
    const s = discardAllSpec({ tracked: 4, untracked: 2 });
    expect(s.detail).toContain("4");
    expect(s.detail).toContain("2");
    expect(s.detail).toContain("apagados");
  });

  it("with no new file at all, the warning does not mention deletion", () => {
    const s = discardAllSpec({ tracked: 3, untracked: 0 });
    expect(s.detail).not.toContain("apagados");
  });
});

describe("branchDeleteSpec", () => {
  it("names the branch", () => {
    expect(branchDeleteSpec("feature/x", false).title).toContain("feature/x");
  });

  it("force-deleting warns that commits get lost — the whole difference", () => {
    expect(branchDeleteSpec("feature/x", true).detail).toContain("commits");
    expect(branchDeleteSpec("feature/x", false).detail).not.toContain("commits");
  });
});

describe("remoteDeleteSpec", () => {
  it("makes it clear the target is the server, not the local copy", () => {
    const s = remoteDeleteSpec("feature/x", "origin");
    expect(s.title).toContain("feature/x");
    expect(s.detail).toContain("origin");
    expect(s.detail).toContain("outras pessoas");
  });
});

describe("resetSpec", () => {
  it("the hard reset is the only one that talks about throwing work away", () => {
    expect(resetSpec("abc1234", "hard").detail).toContain("perde");
    expect(resetSpec("abc1234", "soft").detail).not.toContain("perde");
    expect(resetSpec("abc1234", "mixed").detail).not.toContain("perde");
  });

  it("names the target commit in all three", () => {
    for (const mode of ["soft", "mixed", "hard"] as const) {
      expect(resetSpec("abc1234", mode).title).toContain("abc1234");
    }
  });
});

describe("stashDropSpec", () => {
  it("says the stash has no way back", () => {
    const s = stashDropSpec("On main: rascunho");
    expect(s.title).toContain("rascunho");
    expect(s.detail).toContain("não dá para desfazer");
  });
});
