// Every exit from a form must preserve authored text until discard is explicitly chosen.
import { expect, it } from "vitest";
import { exitWithDraft } from "./draftExit";

it("keeps a dirty form open when discard is declined and closes only after approval", async () => {
  let closed = false;
  await exitWithDraft(
    true,
    async () => false,
    () => {
      closed = true;
    },
  );
  expect(closed).toBe(false);
  let approve!: (value: boolean) => void;
  const pending = exitWithDraft(
    true,
    () =>
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    () => {
      closed = true;
    },
  );
  expect(closed).toBe(false);
  approve(true);
  await pending;
  expect(closed).toBe(true);
});
