// Batch errors must identify the exact row and field, without marking unrelated fields invalid.
import { expect, it } from "vitest";
import { fieldAccessibility } from "./fieldAccessibility";
import { issue } from "../../lib/provision/errors";

it("associates each field only with its own errors using the stable row identity", () => {
  const errors = [
    issue("NAME_TAKEN", { name: "test" }),
    issue("BRANCH_INVALID", { branch: "bad branch" }),
  ];
  expect(fieldAccessibility("row-a", "name", errors)).toEqual({
    "aria-invalid": true,
    "aria-describedby": "row-a-error-0",
  });
  expect(fieldAccessibility("row-b", "branch", errors)).toEqual({
    "aria-invalid": true,
    "aria-describedby": "row-b-error-1",
  });
  expect(fieldAccessibility("row-a", "base", errors)).toEqual({
    "aria-invalid": undefined,
    "aria-describedby": undefined,
  });
});
