// Delivery may finish after the user leaves; its completion must not close a different dialog.
import { expect, it } from "vitest";
import { reportRoleDelivery } from "./roleDelivery";

it("reports delivery after leaving the form without closing the newly opened dialog", async () => {
  let active = true;
  let finish!: (value: boolean) => void;
  let closed = false;
  const reports: boolean[] = [];
  const pending = reportRoleDelivery(
    new Promise((resolve) => {
      finish = resolve;
    }),
    () => active,
    (sent) => reports.push(sent),
    () => {
      closed = true;
    },
  );
  active = false;
  finish(true);
  await pending;
  expect(reports).toEqual([true]);
  expect(closed).toBe(false);
});
