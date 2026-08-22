/**
 * What is left of a component that crashed.
 *
 * Tonight's black screen was only diagnosed because `installErrorBridge`
 * dumped the stack into `yard.log`: it was what said `Cannot access 'active'
 * before initialization` and in which hook. An error boundary that swallowed
 * the error to show "something went wrong" would be **worse** than the crash
 * — it throws away the only evidence.
 *
 * Hence the rules here: the log line says *where* it broke (in a six-pane
 * app, "something broke" is not information) and nothing that was thrown may
 * become `undefined` or `[object Object]` along the way — the code that throws
 * strings or objects is precisely the boundary code, which is where things
 * break most.
 */
import { describe, expect, it } from "vitest";

import { crashLine, crashOf } from "./crash";

describe("crashOf", () => {
  it("carries the Error's message and stack forward", () => {
    const err = new Error("Cannot access 'active' before initialization");
    err.stack = "Error: ...\n    at TerminalPane (index.tsx:186)";
    const crash = crashOf(err, "este painel");
    expect(crash.message).toBe("Cannot access 'active' before initialization");
    expect(crash.stack).toContain("TerminalPane");
    expect(crash.where).toBe("este painel");
  });

  it("a thrown string stays readable — no 'undefined'", () => {
    expect(crashOf("o pty morreu", "este painel").message).toBe("o pty morreu");
  });

  it("a thrown object does not become '[object Object]'", () => {
    expect(crashOf({ code: 5 }, "este painel").message).toBe('{"code":5}');
  });

  it("an Error with no message still says something", () => {
    expect(crashOf(new Error(), "este painel").message).not.toBe("");
  });
});

describe("crashLine", () => {
  it("says where it broke — the half the stack does not give", () => {
    const row = crashLine(crashOf(new Error("boom"), "este painel"));
    expect(row).toContain("este painel");
    expect(row).toContain("boom");
  });

  it("without a stack, the line still comes out whole", () => {
    const error = new Error("boom");
    error.stack = undefined;
    expect(crashLine(crashOf(error, "o Yard"))).toContain("boom");
  });
});
