// Icon themes share precedence while keeping their own asset and folder policies.
import { expect, it } from "vitest";
import { folded, resolveFileIcon } from "./resolve";

it("prefers exact names then the longest available suffix with case folding", () => {
  const names = folded({
    "special.test.ts": "exact",
    "missing.test.ts": "missing",
  });
  const extensions = folded({ "TEST.TS": "test", ts: "ts" });
  const asset = (name: string | undefined) =>
    name && name !== "missing" ? name : null;
  expect(
    resolveFileIcon("SPECIAL.TEST.TS", names, extensions, "file", asset),
  ).toBe("exact");
  expect(
    resolveFileIcon("missing.test.ts", names, extensions, "file", asset),
  ).toBe("test");
  expect(resolveFileIcon("a.ts", names, extensions, "file", asset)).toBe("ts");
  expect(resolveFileIcon("README", names, extensions, "file", asset)).toBe(
    "file",
  );
});
