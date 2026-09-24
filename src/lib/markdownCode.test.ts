// Prompts can contain source backticks and must keep them inside one code span.
import { expect, it } from "vitest";
import { inlineCode } from "./markdownCode";

it("uses a longer fence and edge padding for embedded backticks", () => {
  expect(inlineCode("`a``b`")).toBe("``` `a``b` ```");
  expect(inlineCode("plain")).toBe("`plain`");
});
