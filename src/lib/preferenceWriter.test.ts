// Autosave must write changed keys and wait for the latest acknowledged draft.
import { expect, it } from "vitest";
import { PreferenceWriter } from "./preferenceWriter";

it("persists changed values without rewriting unrelated preferences", async () => {
  const batches: [string, string][][] = [];
  const writer = new PreferenceWriter(async (entries) => {
    batches.push(entries);
  });
  await writer.write({ draft: "first", wrap: "true" });
  await writer.write({ draft: "second", wrap: "true" });
  await writer.write({ draft: "second", wrap: "true" });
  expect(batches).toEqual([
    [
      ["draft", "first"],
      ["wrap", "true"],
    ],
    [["draft", "second"]],
  ]);
});

it("waits for an older save before acknowledging the latest draft", async () => {
  let release!: () => void;
  let stored = "";
  let first = true;
  const writer = new PreferenceWriter(async (entries) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    stored = entries[0][1];
  });
  const older = writer.write({ draft: "older" });
  await Promise.resolve();
  await Promise.resolve();
  const latest = writer.write({ draft: "latest" });
  release();
  await Promise.all([older, latest]);
  expect(stored).toBe("latest");
});

it("retries values rejected by storage instead of treating them as saved", async () => {
  let failing = true;
  let stored = "";
  const writer = new PreferenceWriter(async (entries) => {
    if (failing) throw new Error("disk full");
    stored = entries[0][1];
  });
  await expect(writer.write({ draft: "latest" })).rejects.toThrow("disk full");
  failing = false;
  await writer.write({ draft: "latest" });
  expect(stored).toBe("latest");
});
