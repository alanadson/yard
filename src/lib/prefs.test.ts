/** Queue edits must cross the persistence boundary with their observed predecessor. */
import { describe, expect, it, vi } from "vitest";

import * as prefs from "./prefs";
import { readInitialPrefs, readPrefs, setPrefsTransport } from "./prefs";

describe("preference repository", () => {
  it("sends the observed queue and requested edits to the native boundary instead of replacing its snapshot", async () => {
    const first = { id: "first", terminalId: "agent", text: "First request", at: 1000, source: "user" as const };
    const added = { ...first, id: "added" };
    const unseen = { ...first, id: "native" };
    let received: unknown;
    const restore = setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => { throw new Error("Full snapshot forbidden"); },
      patchQueue: async (before, after) => { received = { before, after }; return [first, unseen, added]; } });
    try {
      expect(await prefs.writeQueue([first], [first, added])).toEqual([first, unseen, added]);
      expect(received).toEqual({ before: [first], after: [first, added] });
    } finally { restore(); }
  });
  it("shares the boot read but keeps explicit reloads fresh", async () => {
    const read = vi
      .fn<() => Promise<Record<string, string>>>()
      .mockResolvedValueOnce({ theme: "dark" })
      .mockResolvedValueOnce({ theme: "light" });
    const restore = setPrefsTransport({
      readPrefs: read,
      writePref: vi.fn().mockResolvedValue(undefined),
    });
    try {
      const [a, b] = await Promise.all([
        readInitialPrefs(),
        readInitialPrefs(),
      ]);
      expect(a).toEqual({ theme: "dark" });
      expect(b).toBe(a);
      expect(read).toHaveBeenCalledTimes(1);

      await expect(readPrefs()).resolves.toEqual({ theme: "light" });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});
