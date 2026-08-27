/**
 * The grammar for the ignore files — `.gitignore` and the four siblings that
 * copied its format (`.dockerignore`, `.npmignore`, `.eslintignore`,
 * `.prettierignore`).
 *
 * These used to open in the `.properties` mode, which is the closest thing
 * the shelf of legacy modes has to "a config file with `#` comments" — and it
 * is wrong about this format twice, both times *confidently*:
 *
 * - a line starting with `!` is a comment in a properties file and a
 *   **negation** here, so the one line whose job is to say "except this"
 *   was drawn in the ink the editor uses for "this does not count";
 * - a line starting with `[` opens a section header there, so `[Bb]uild/` —
 *   the case-insensitive glob in every .NET and Unity template — was painted
 *   as a heading, bracket group swallowed whole.
 *
 * Neither reads as a missing colour on screen, which is exactly why it needed
 * its own grammar rather than a wider palette: the file was fully coloured, in
 * a way that inverted what it says.
 *
 * The format is small enough to be honest about. A line is a comment, or a
 * pattern; a pattern may open with `!`, and inside it the glob characters
 * (`*`, `?`, `/`, and a `[…]` group) are the only things that are not a
 * literal name. Everything else stays plain — the same restraint the rest of
 * the registry keeps, where a colour that means nothing is worse than none.
 *
 * The three styles it emits — `comment`, `operator`, and plain — are all
 * names `StreamLanguage`'s default table already maps onto tags both highlight
 * tables paint (`languages.test.ts` holds that, so a scheme cannot leave this
 * grammar half-lit).
 */
import type { StringStream } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";

/** `*`, `?` and `/` are structure; anything else in a pattern is a name. */
const GLOB = /[*?/]/;

export const ignoreParser: StreamParser<Record<string, never>> = {
  name: "gitignore",

  startState: () => ({}),

  token(stream: StringStream): string | null {
    const from = stream.pos;
    // Indentation is not the line's content: `sol()` goes false the moment it
    // is eaten, so what a line *opens* with is decided before that.
    const opening = stream.sol();
    if (opening) stream.eatSpace();

    if (opening && !stream.eol()) {
      // A comment only opens a line. A `#` inside a pattern is a literal
      // character, and greying out the tail of a legitimate rule is the same
      // class of lie this grammar exists to stop telling.
      if (stream.peek() === "#") {
        stream.skipToEnd();
        return "comment";
      }
      // The negation carries the whole meaning of the line, so it is marked,
      // and the pattern behind it is read like any other.
      if (stream.eat("!")) return "operator";
    }
    if (stream.pos > from) return null; // indentation, and nothing after it

    if (stream.eat("[")) {
      // A bracket group is a glob, never a section header: taken whole, so a
      // `/` or `!` inside the class is not read as structure of its own.
      stream.eatWhile((c: string) => c !== "]");
      stream.eat("]");
      return "operator";
    }
    if (stream.eatWhile(GLOB)) return "operator";

    // The literal part of the pattern: up to the next glob character.
    stream.eatWhile((c: string) => !GLOB.test(c) && c !== "[");
    // A character that is none of the above (a lone `]`, say) still has to
    // move the stream on, or the parser spins on it forever.
    if (stream.pos === from) stream.next();
    return null;
  },
};
