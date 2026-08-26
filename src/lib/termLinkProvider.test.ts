/**
 * The provider is the seam between the pure matcher and xterm: it reads one
 * buffer row, hands back ranges in xterm's coordinates, and — the rule that
 * matters — only opens on Ctrl (or Meta) + click. A plain click on a path in
 * the middle of a CLI's screen must keep meaning "focus here", or a stray
 * click during a selection starts opening editor tabs.
 */
import { describe, expect, it } from "vitest";

import { termLinkProvider } from "./termLinkProvider";
import type { LinkMatch } from "./termLinks";

function fakeTerm(rows: string[]) {
  return {
    buffer: {
      active: {
        getLine: (y: number) =>
          rows[y] === undefined ? undefined : { translateToString: () => rows[y] },
      },
    },
  };
}

function click(ctrl: boolean): MouseEvent {
  return { ctrlKey: ctrl, metaKey: false } as MouseEvent;
}

describe("termLinkProvider", () => {
  it("answers a row with its links in xterm's 1-based cells, and `undefined` for a row with none", () => {
    const term = fakeTerm(["nothing here", "see src/x.ts:3 now"]);
    const provider = termLinkProvider(term, () => {});
    let got: unknown = "unset";
    provider.provideLinks(1, (links) => (got = links));
    expect(got).toBeUndefined();
    provider.provideLinks(2, (links) => (got = links));
    expect(got).toMatchObject([{ text: "src/x.ts:3", range: { start: { x: 5, y: 2 }, end: { x: 14, y: 2 } } }]);
  });

  it("opens only on Ctrl+click — a plain click keeps its meaning", () => {
    const opened: LinkMatch[] = [];
    const provider = termLinkProvider(fakeTerm(["see src/x.ts:3 now"]), (m) => opened.push(m));
    provider.provideLinks(1, (links) => {
      links![0].activate(click(false), "src/x.ts:3");
      expect(opened).toEqual([]);
      links![0].activate(click(true), "src/x.ts:3");
      expect(opened).toMatchObject([{ path: "src/x.ts", line: 3 }]);
    });
  });
});
