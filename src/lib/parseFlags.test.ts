/**
 * Flag parsing of the `yard` CLI.
 *
 * The `--file` / `--stdin` pair is the reason this is worth locking down:
 * `cmd.exe` eats line breaks in `%*`, the shim rewrites `--file X` as
 * `--stdin`, and both spellings have to reach every command that takes long
 * text. Six hand-written loops used to do this — one of them accepting the
 * flag in positions the others rejected.
 */
import { describe, expect, it } from "vitest";

import { parseFlags } from "./bridgeCore";

describe("parseFlags", () => {
  it("keeps unknown tokens as positionals, in order", () => {
    const p = parseFlags(["Agente", "prompt", "--nope"], { "--raw": "bool" });
    expect(p.positional).toEqual(["Agente", "prompt", "--nope"]);
  });

  it("reads bools, strings and numbers", () => {
    const p = parseFlags(["--once", "--role", "revisora", "--every", "15"], {
      "--once": "bool",
      "--role": "string",
      "--every": "number",
    });
    expect(p.bool.once).toBe(true);
    expect(p.string.role).toBe("revisora");
    expect(p.number.every).toBe(15);
  });

  it("ignores a number flag with junk instead of yielding NaN", () => {
    const p = parseFlags(["--every", "abc"], { "--every": "number" });
    expect(p.number.every).toBeUndefined();
  });

  it("treats --stdin and --file alike, consuming only --file's value", () => {
    const spec = { "--stdin": "stdin", "--file": "stdin" } as const;
    const viaStdin = parseFlags(["Nota", "--stdin"], spec);
    expect(viaStdin.fromStdin).toBe(true);
    expect(viaStdin.positional).toEqual(["Nota"]);

    const viaFile = parseFlags(["Nota", "--file", "plano.md"], spec);
    expect(viaFile.fromStdin).toBe(true);
    // The path is the flag's value, never a positional.
    expect(viaFile.positional).toEqual(["Nota"]);
  });

  it("accepts the flag in any position", () => {
    const spec = { "--stdin": "stdin" } as const;
    expect(parseFlags(["--stdin", "Nota"], spec).positional).toEqual(["Nota"]);
    expect(parseFlags(["Nota", "--stdin"], spec).positional).toEqual(["Nota"]);
  });

  it("strips the dashes from the key", () => {
    const p = parseFlags(["--no-wait", "--copy-ground"], {
      "--no-wait": "bool",
      "--copy-ground": "bool",
    });
    expect(p.bool["no-wait"]).toBe(true);
    expect(p.bool["copy-ground"]).toBe(true);
  });

  it("keeps the last value when a flag repeats", () => {
    const p = parseFlags(["--dir", "a", "--dir", "b"], { "--dir": "string" });
    expect(p.string.dir).toBe("b");
  });

  it("returns empty maps for an empty argv", () => {
    const p = parseFlags([], { "--raw": "bool" });
    expect(p.positional).toEqual([]);
    expect(p.fromStdin).toBe(false);
    expect(p.bool.raw).toBeUndefined();
  });
});
