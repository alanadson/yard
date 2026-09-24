// Finishing the prerequisite must resume in the created front, not reopen the old destination.
import { expect, it } from "vitest";
import { frontToResume } from "./frontContinuation";

it("resumes only a successfully created single front requested from the new tab flow", () => {
  const items = [{ groupId: "new-front", state: "ready" }];
  expect(frontToResume("new-terminal", "done", items)?.groupId).toBe(
    "new-front",
  );
  expect(frontToResume("new-terminal", "running", items)).toBeNull();
  expect(
    frontToResume("new-terminal", "done", [
      { groupId: "new-front", state: "failed" },
    ]),
  ).toBeNull();
  expect(frontToResume(null, "done", items)).toBeNull();
});
