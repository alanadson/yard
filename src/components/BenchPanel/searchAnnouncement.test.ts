// Search announcements describe only the current request, never stale results while typing.
import { expect, it } from "vitest";
import { searchAnnouncement } from "./searchAnnouncement";

it("announces loading, failures and current results without announcing stale matches", () => {
  const result = { hits: 3, filesHit: 2, filesScanned: 10, truncated: false };
  expect(searchAnnouncement("done", false, result, null)).toBe("");
  expect(searchAnnouncement("searching", false, result, null)).toBe(
    "buscando…",
  );
  expect(searchAnnouncement("error", false, result, "Expressão inválida")).toBe(
    "Expressão inválida",
  );
  expect(searchAnnouncement("done", true, result, null)).toBe(
    "3 linha(s) em 2 arquivo(s).",
  );
  expect(searchAnnouncement("done", true, { ...result, hits: 0 }, null)).toBe(
    "Nenhum resultado em 10 arquivos.",
  );
});
