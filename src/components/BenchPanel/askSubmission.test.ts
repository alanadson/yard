// SCM questions retain their input until the requested operation actually succeeds.
import { expect, it } from "vitest";
import { submitQuestion } from "./askSubmission";

it("keeps a question open on validation or operation failure and closes only on success", async () => {
  let closed = false;
  const close = () => {
    closed = true;
  };
  expect(await submitQuestion("  ", false, async () => null, close)).toBe(
    "required",
  );
  expect(closed).toBe(false);
  expect(
    await submitQuestion(
      " feature/test ",
      false,
      async (value) => (value === "feature/test" ? "branch exists" : null),
      close,
    ),
  ).toBe("branch exists");
  expect(closed).toBe(false);
  let finish!: (error: string | null) => void;
  const pending = submitQuestion(
    "feature/test",
    false,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    close,
  );
  expect(closed).toBe(false);
  finish(null);
  expect(await pending).toBeNull();
  expect(closed).toBe(true);
});
