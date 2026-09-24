// Keyboard connection creation follows the same endpoint and duplicate rules as pointer creation.
import { expect, it } from "vitest";
import { connectionIssue } from "./connectionForm";

it("permits distinct live endpoints and refuses missing, self and duplicate connections", () => {
  const endpoints = ["agent", "note", "flow"];
  const wires = [{ from: "agent", to: "note" }];
  expect(connectionIssue(endpoints, wires, "agent", "flow")).toBeNull();
  expect(connectionIssue(endpoints, wires, "agent", "note")).toBe("duplicate");
  expect(connectionIssue(endpoints, wires, "agent", "agent")).toBe("same");
  expect(connectionIssue(endpoints, wires, "agent", "deleted")).toBe("missing");
});
