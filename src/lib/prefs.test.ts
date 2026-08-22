import { describe, expect, it, vi } from "vitest";

import { readInitialPrefs, readPrefs, setPrefsTransport } from "./prefs";

describe("preference repository", () => {
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
