/**
 * Line endings, as something the reader can change.
 *
 * The editor has always detected them and written back whatever the file had,
 * which is the right default and was, until now, the only behaviour. On a
 * Windows machine sharing repositories with Linux, "this file should be LF"
 * is a thing people need to be able to say.
 *
 * The trap is the mixed file, and it is not a rare one: an agent appending LF
 * lines to a CRLF file produces one all day. Converting therefore means the
 * file comes out consistent, not that the endings which already looked right
 * are left where they are.
 */

/** What a text uses. `none` = a single line, with nothing to read. */
export type Eol = "crlf" | "lf" | "mixed" | "none";

/** Every line ending in `text` as CRLF, or as LF. */
export function convertEol(text: string, crlf: boolean): string {
  // Through LF first, so a mixed file comes out consistent either way.
  const lf = text.replace(/\r\n/g, "\n");
  return crlf ? lf.replace(/\n/g, "\r\n") : lf;
}

/** What the text uses, for the line the status footer draws. */
export function eolOf(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // Every `\n` that is not the second half of a `\r\n`.
  const lf = (text.match(/(^|[^\r])\n/g) ?? []).length;
  if (crlf === 0 && lf === 0) return "none";
  if (crlf > 0 && lf > 0) return "mixed";
  return crlf > 0 ? "crlf" : "lf";
}
