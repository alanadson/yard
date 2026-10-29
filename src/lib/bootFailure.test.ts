/**
 * The boot failure screen tells the user what to do next, and a wrong hint
 * sends them after the wrong fix. The case that motivated this: an installed
 * build older than the database refused to open it, and the screen blamed a
 * second Yard instance, so closing windows and retrying could never work.
 */
import { describe, expect, it } from "vitest";

import { bootFailureCause } from "./bootFailure";

describe("bootFailureCause", () => {
  it("a database migrated by a newer build asks for an update, not for closing another instance", () => {
    expect(
      bootFailureCause("workspace schema 10 requires a newer Yard version (supported: 9)"),
    ).toBe("olderBuild");
  });

  it("any other failure keeps the second-instance hint", () => {
    expect(bootFailureCause("database is locked")).toBe("otherInstance");
  });
});
