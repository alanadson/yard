/**
 * `.gitignore` was being read as a `.properties` file, and that grammar makes
 * two confident, wrong statements about it.
 *
 * The first is the expensive one. In a properties file a line opening with
 * `!` is a comment; in a `.gitignore` it is a **negation** — the line that
 * un-ignores something, the single most load-bearing kind of line the format
 * has. So `!build/keep.txt` came out grey and italic, drawn exactly like the
 * thing the editor uses to say "this does not count".
 *
 * The second: `[` at the start of a line opens a section header in
 * properties, so `[Bb]uild/` — the case-insensitive glob every .NET and Unity
 * template ships with — was painted as a heading, and `skipTo("]")` ate the
 * bracket group whole.
 *
 * Neither is a missing colour, which is what makes them worth a grammar of
 * their own: the file was fully coloured, in a way that inverted its meaning.
 * The parser is a handful of lines, so what is tested is what it *says* about
 * each kind of line, tag by tag.
 */
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";

import { ignoreParser } from "./ignoreSyntax";

/** The token style the parser gives each run of a line, in order. */
function tokens(line: string): { text: string; style: string | null }[] {
  const stream = new StringStream(line, 2, 2);
  const state = ignoreParser.startState!(2);
  const out: { text: string; style: string | null }[] = [];
  // A stream parser that neither consumes nor returns would spin forever; the
  // guard turns that into a failing test instead of a hung suite.
  while (!stream.eol()) {
    const before = stream.pos;
    const style = ignoreParser.token(stream, state);
    expect(stream.pos, `no progress at ${before} in "${line}"`).toBeGreaterThan(before);
    out.push({ text: line.slice(before, stream.pos), style: style ?? null });
  }
  return out;
}

/** Every style the line carries, deduped — for "does this appear at all". */
const stylesOf = (line: string) => new Set(tokens(line).map((t) => t.style));

describe("the ignore grammar", () => {
  it("reads a whole-line comment as a comment", () => {
    expect(tokens("# dependencies")).toEqual([{ text: "# dependencies", style: "comment" }]);
  });

  /**
   * The regression this file exists for. `!` is the negation, and properties
   * mode called the whole line a comment — the editor said "ignored" about
   * the one line whose job is to say the opposite.
   */
  it("does not call a negation a comment — that is the bug this grammar fixes", () => {
    const styles = stylesOf("!build/keep.txt");
    expect(styles.has("comment"), "the negation is still being read as a comment").toBe(false);
  });

  it("marks the negating `!` as an operator, and leaves the pattern after it", () => {
    const [bang, ...rest] = tokens("!build/keep.txt");
    expect(bang).toEqual({ text: "!", style: "operator" });
    expect(rest.map((t) => t.text).join("")).toBe("build/keep.txt");
  });

  /**
   * The other half: `[Bb]uild/` is a glob, not a section header, and the
   * bracket group is one of the few things in the file that is not a literal
   * name — so it reads as an operator, like the `*` beside it.
   */
  it("does not call a bracket glob a section header", () => {
    expect(stylesOf("[Bb]uild/").has("header")).toBe(false);
  });

  it("picks the wildcards out of a pattern and leaves the literal parts alone", () => {
    const byStyle = (style: string | null) =>
      tokens("**/*.log")
        .filter((t) => t.style === style)
        .map((t) => t.text)
        .join("");
    expect(byStyle("operator")).toBe("**/*");
    expect(byStyle(null)).toBe(".log");
  });

  it("keeps a plain pattern plain — no colour beats a colour that means nothing", () => {
    expect(tokens("node_modules")).toEqual([{ text: "node_modules", style: null }]);
  });

  /**
   * A `#` only opens a comment at the start of a line; inside a pattern it is
   * a literal character (escaped as `\#`, but git accepts it mid-pattern too).
   * Getting this wrong greys out the tail of a legitimate rule.
   */
  it("does not open a comment on a `#` in the middle of a pattern", () => {
    expect(stylesOf("build/v#1/").has("comment")).toBe(false);
  });

  it("still comments a line that only has whitespace before the `#`", () => {
    expect(stylesOf("   # indented note").has("comment")).toBe(true);
  });
});

/**
 * The other half of "the theme reaches this file". A stream parser hands back
 * CodeMirror-5 style *names*, and `StreamLanguage` maps those onto tags
 * through a fixed table — so a name outside that table (or outside what the
 * highlight tables paint) produces a file that opens uncoloured whichever
 * theme is on, with nothing anywhere reporting a problem.
 *
 * Both names below are painted by the Yard's palette and by every scheme;
 * `schemeSyntax.test.ts` holds that end. This end is that the grammar never
 * starts emitting a third.
 */
describe("what the grammar asks the theme for", () => {
  const SAMPLE = [
    "# dependencies",
    "node_modules",
    "!build/keep.txt",
    "[Bb]uild/",
    "**/*.log",
    "   # indented note",
    "build/v#1/",
  ];

  it("asks for two style names and no more — both of them painted in every theme", () => {
    const asked = new Set(SAMPLE.flatMap((line) => tokens(line).map((tk) => tk.style)));
    asked.delete(null); // the literal parts of a pattern, deliberately plain
    expect([...asked].sort()).toEqual(["comment", "operator"]);
  });
});
