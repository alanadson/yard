/**
 * The "skip the prompts" checkbox writes into the same text field the user
 * types in — so ticking it, unticking it, or swapping CLI must neither
 * scramble what was already there nor leave half a flag behind.
 */
import { describe, expect, it } from "vitest";

import {
  hasFlag,
  quoteArgs,
  skipFlagOf,
  tokenizeArgs,
  withFlag,
} from "./termArgs";

const SKIP = ["--dangerously-skip-permissions"];
const MODEL_FLAG = ["--model", "opus"];

describe("withFlag", () => {
  it("turns the flag on and off", () => {
    expect(withFlag("", SKIP, true)).toBe("--dangerously-skip-permissions");
    expect(withFlag("--dangerously-skip-permissions", SKIP, false)).toBe("");
  });

  it("removes the whole sequence, not just the first token", () => {
    const having = withFlag("--verbose", MODEL_FLAG, true);
    expect(having).toBe("--verbose --model opus");
    expect(withFlag(having, MODEL_FLAG, false)).toBe("--verbose");
  });

  it("preserves what was typed by hand", () => {
    expect(withFlag("  --add-dir  ../api   --verbose ", SKIP, true)).toBe(
      "--add-dir ../api --verbose --dangerously-skip-permissions",
    );
  });

  it("does not reformat the line when nothing changes", () => {
    const row = "  --add-dir  ../api  ";
    expect(withFlag(row, SKIP, false)).toBe(row);
    expect(withFlag(`${row} --dangerously-skip-permissions`, SKIP, true)).toBe(
      `${row} --dangerously-skip-permissions`,
    );
  });

  it("turning it off removes every occurrence", () => {
    expect(withFlag("--yolo --verbose --yolo", ["--yolo"], false)).toBe("--verbose");
  });
});

describe("hasFlag", () => {
  it("does not mistake a flag for the prefix of another", () => {
    expect(hasFlag("--model opus", MODEL_FLAG)).toBe(true);
    expect(hasFlag("--model opusmax", MODEL_FLAG)).toBe(false);
    expect(hasFlag("--model", MODEL_FLAG)).toBe(false);
  });
});

describe("tokenizeArgs", () => {
  it("keeps a quoted value together", () => {
    expect(tokenizeArgs('--append-system-prompt "seja breve"')).toEqual([
      "--append-system-prompt",
      "seja breve",
    ]);
    expect(tokenizeArgs("--role 'revisora chefe' --verbose")).toEqual([
      "--role",
      "revisora chefe",
      "--verbose",
    ]);
  });

  it("does not treat the backslash as an escape — it is a Windows path", () => {
    expect(tokenizeArgs("--add-dir C:\\repo\\api")).toEqual([
      "--add-dir",
      "C:\\repo\\api",
    ]);
    expect(tokenizeArgs('--add-dir "C:\\Program Files\\x"')).toEqual([
      "--add-dir",
      "C:\\Program Files\\x",
    ]);
  });

  it("preserves an explicit empty argument and accepts quotes glued to a token", () => {
    expect(tokenizeArgs('--prefix ""')).toEqual(["--prefix", ""]);
    expect(tokenizeArgs('--msg="dois tokens"')).toEqual(["--msg=dois tokens"]);
  });

  it("unclosed quotes run to the end of the line", () => {
    expect(tokenizeArgs('--msg "ainda digitando')).toEqual([
      "--msg",
      "ainda digitando",
    ]);
  });

  it("extra spaces and an empty field do not become arguments", () => {
    expect(tokenizeArgs("   ")).toEqual([]);
    expect(tokenizeArgs("  --a    --b  ")).toEqual(["--a", "--b"]);
  });
});

describe("quoteArgs", () => {
  it("makes the trip back without altering what does not need it", () => {
    expect(quoteArgs(["--verbose", "--model", "opus"])).toBe("--verbose --model opus");
  });

  it("is the inverse of tokenizeArgs", () => {
    const argv = ["--append-system-prompt", "seja breve", "--dir", "C:\\a b\\c", ""];
    expect(tokenizeArgs(quoteArgs(argv))).toEqual(argv);
  });
});

describe("skipFlagOf", () => {
  it("each CLI writes its own", () => {
    expect(skipFlagOf("agent", "claude")?.args).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(skipFlagOf("agent", "codex")?.args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(skipFlagOf("agent", "gemini")?.args).toEqual(["--yolo"]);
  });

  it("a shell has no permission to skip, and neither does a CLI with no known flag", () => {
    expect(skipFlagOf("shell", "pwsh")).toBeNull();
    expect(skipFlagOf("agent", "grok")).toBeNull();
    expect(skipFlagOf("agent", "goose")).toBeNull();
  });
});
