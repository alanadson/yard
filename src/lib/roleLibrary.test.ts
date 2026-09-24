// A failed library read must not be treated as an empty library and overwrite saved roles.
import { expect, it, vi } from "vitest";
const { stored, readPrefs } = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  readPrefs: vi.fn(async (): Promise<Record<string, string>> => {
    throw new Error("database unavailable");
  }),
}));
vi.mock("./ipc", () => ({
  ipc: {
    readPrefs,
    writePref: async (key: string, value: string) => {
      stored.set(key, value);
    },
  },
}));
import { readGlobalRoles, writeGlobalRole } from "./roles";

it("surfaces failed reads and preserves the library when saving cannot read existing roles", async () => {
  stored.set("rolePresets", '{"Reviewer":"Review carefully"}');
  await expect(readGlobalRoles()).rejects.toThrow("database unavailable");
  await expect(
    writeGlobalRole("Tester", { text: "Run tests" }),
  ).rejects.toThrow("database unavailable");
  expect(stored.get("rolePresets")).toBe('{"Reviewer":"Review carefully"}');
});
