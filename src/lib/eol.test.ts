/**
 * Line endings, as something the reader can change.
 *
 * The editor has always *detected* them and written back whatever the file
 * had, which is the right default and, until now, the only behaviour. There
 * was no way to say "this file should be LF" short of opening it in another
 * program, and on a Windows machine that shares repositories with Linux that
 * comes up.
 *
 * The conversion is the whole of it, and the trap is that a file is routinely
 * mixed: an agent appends LF lines to a CRLF file all day. Converting has to
 * mean the file ends up consistent, not that the existing endings are left
 * alone wherever they already looked right.
 */
import { describe, expect, it } from "vitest";

import { convertEol, eolOf } from "./eol";

describe("convertEol", () => {
  it("turns every line ending into CRLF", () => {
    expect(convertEol("um\ndois\ntres", true)).toBe("um\r\ndois\r\ntres");
  });

  it("turns every line ending into LF", () => {
    expect(convertEol("um\r\ndois\r\ntres", false)).toBe("um\ndois\ntres");
  });

  it("leaves a file that already matches untouched", () => {
    const crlf = "um\r\ndois";
    expect(convertEol(crlf, true)).toBe(crlf);
  });

  it("makes a mixed file consistent", () => {
    // The case that actually happens: an agent appends LF lines to a CRLF
    // file. Converting has to mean the file ends up one way, not that the
    // endings that already looked right are left alone.
    expect(convertEol("um\r\ndois\ntres", true)).toBe("um\r\ndois\r\ntres");
    expect(convertEol("um\r\ndois\ntres", false)).toBe("um\ndois\ntres");
  });

  it("keeps a trailing line ending", () => {
    expect(convertEol("um\n", true)).toBe("um\r\n");
    expect(convertEol("um\r\n", false)).toBe("um\n");
  });

  it("leaves a lone carriage return alone", () => {
    // A bare `\r` is not a line ending anything writes today; it is far more
    // likely to be data, and rewriting data is not this function's job.
    expect(convertEol("um\rdois", true)).toBe("um\rdois");
  });

  it("has nothing to do to an empty file", () => {
    expect(convertEol("", true)).toBe("");
    expect(convertEol("", false)).toBe("");
  });
});

describe("eolOf", () => {
  it("reads what the text mostly uses", () => {
    expect(eolOf("um\r\ndois\r\n")).toBe("crlf");
    expect(eolOf("um\ndois\n")).toBe("lf");
  });

  it("calls a mixed file mixed, so the footer can say so", () => {
    expect(eolOf("um\r\ndois\ntres")).toBe("mixed");
  });

  it("calls a file with no line ending at all by the default", () => {
    // One line and no break: there is nothing to read, and claiming "mixed"
    // would light a warning about a file that has no problem.
    expect(eolOf("uma linha só")).toBe("none");
  });
});
