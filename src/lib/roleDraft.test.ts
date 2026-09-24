// Role validation identifies the field to focus and gives an actionable instruction.
import { expect, it } from "vitest";
import { roleDraftError } from "./roleDraft";
import { ROLE_NAME_MAX } from "./canvas";

it("identifies missing instructions and invalid role names without rejecting a complete draft", () => {
  expect(roleDraftError(" ", "Run tests")?.field).toBe("name");
  expect(
    roleDraftError("x".repeat(ROLE_NAME_MAX + 1), "Run tests")?.field,
  ).toBe("name");
  expect(roleDraftError("Tester", " ")).toEqual({
    field: "text",
    message: "Escreva as instruções que este agente deve seguir.",
  });
  expect(roleDraftError("Tester", "Run tests")).toBeNull();
});
