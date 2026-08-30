/**
 * Why these rules matter: the journal is written *for the next morning*, when
 * the session is gone and only this text is left. Two ways to make it
 * useless: leaving out what actually happened (the commits), and padding it
 * with numbers that were never real (an estimate presented as a total, a day
 * with no work presented as a day of work).
 */
import { describe, expect, it } from "vitest";

import { journalMarkdown } from "./journal";

const base = {
  day: "2026-08-28",
  project: "yard",
  commits: [
    { hash: "abc1234", subject: "feat(busca): procurar no que os terminais disseram" },
    { hash: "def5678", subject: "fix(fila): não entregar dois prompts de uma vez" },
  ],
  spendUsd: 4.2,
  spendPartial: false,
  agents: ["claude", "codex"],
};

describe("journalMarkdown", () => {
  it("opens with the day and the project", () => {
    const text = journalMarkdown(base);
    expect(text).toContain("2026-08-28");
    expect(text).toContain("yard");
  });

  it("lists the commits, subject first — that is what happened", () => {
    const text = journalMarkdown(base);
    expect(text).toContain("procurar no que os terminais disseram");
    expect(text).toContain("abc1234");
  });

  it("names who was working", () => {
    expect(journalMarkdown(base)).toContain("claude");
  });

  it("says the spend", () => {
    expect(journalMarkdown(base)).toContain("4.20");
  });

  /** An estimate with an unpriced model in it is a floor, and says so. */
  it("marks a partial sum as a floor instead of a total", () => {
    const text = journalMarkdown({ ...base, spendPartial: true });
    expect(text).toContain("pelo menos");
  });

  it("says plainly when nothing was committed, rather than showing an empty list", () => {
    const text = journalMarkdown({ ...base, commits: [] });
    expect(text.toLowerCase()).toContain("nenhum commit");
  });

  it("leaves the spend line out when there is no estimate at all", () => {
    const text = journalMarkdown({ ...base, spendUsd: 0 });
    expect(text).not.toContain("US$ 0.00");
  });

  it("ends with room for the human to write — the point is the note, not the report", () => {
    expect(journalMarkdown(base)).toContain("## Notas");
  });
});
