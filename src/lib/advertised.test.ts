/**
 * What a dev server actually prints — coloured, split across reads, and
 * mixed with links nobody wants to open.
 */
import { describe, expect, it } from "vitest";

import {
  createUrlScanner,
  groupAdvertised,
  hostKind,
  mergeAdvertised,
  scanUrls,
  stripTerminalControls,
  type AdvertisedUrl,
} from "./advertised";

describe("stripTerminalControls", () => {
  it("removes colour sequences from inside a URL", () => {
    const raw = "  Local: http://localhost:[1m5173[0m/\n";
    expect(stripTerminalControls(raw)).toBe("  Local: http://localhost:5173/\n");
  });

  it("removes an OSC title sequence", () => {
    expect(stripTerminalControls("]0;viteok")).toBe("ok");
  });
});

describe("hostKind", () => {
  it("knows the loopback names", () => {
    for (const host of ["localhost", "127.0.0.1", "127.5.5.5", "::1", "0.0.0.0"]) {
      expect(hostKind(host)).toBe("loopback");
    }
  });

  it("knows the private ranges", () => {
    for (const host of ["10.0.0.4", "192.168.1.9", "172.16.0.1", "172.31.255.1"]) {
      expect(hostKind(host)).toBe("private");
    }
  });

  it("refuses the internet", () => {
    expect(hostKind("example.com")).toBeNull();
    expect(hostKind("8.8.8.8")).toBeNull();
    // Just outside the private block.
    expect(hostKind("172.32.0.1")).toBeNull();
  });
});

describe("scanUrls", () => {
  it("finds the two lines vite prints", () => {
    const text = [
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: http://192.168.0.14:5173/",
    ].join("\n");
    expect(scanUrls(text, 7).map((u) => u.origin)).toEqual([
      "http://localhost:5173",
      "http://192.168.0.14:5173",
    ]);
    expect(scanUrls(text, 7)[0]).toMatchObject({ port: 5173, kind: "loopback", at: 7 });
  });

  it("ignores documentation links", () => {
    expect(scanUrls("veja https://vitejs.dev/guide/")).toEqual([]);
  });

  it("rewrites a wildcard bind to something openable", () => {
    expect(scanUrls("Listening on http://0.0.0.0:3000")[0].origin).toBe(
      "http://localhost:3000",
    );
  });

  it("does not absorb the punctuation that follows", () => {
    expect(scanUrls("aberto em (http://localhost:8080), pronto")[0].origin).toBe(
      "http://localhost:8080",
    );
  });

  it("defaults the port from the scheme", () => {
    expect(scanUrls("http://localhost/")[0].port).toBe(80);
    expect(scanUrls("https://127.0.0.1/")[0].port).toBe(443);
  });

  it("returns one entry per origin", () => {
    const text = "http://localhost:5173/a http://localhost:5173/b";
    expect(scanUrls(text)).toHaveLength(1);
  });
});

describe("createUrlScanner", () => {
  it("waits for the end of the line before scanning", () => {
    const scanner = createUrlScanner();
    expect(scanner.feed("  Local: http://localhost:51")).toEqual([]);
    expect(scanner.feed("73/\n").map((u) => u.origin)).toEqual([
      "http://localhost:5173",
    ]);
  });

  it("accepts a bare carriage return as the end of a line", () => {
    const scanner = createUrlScanner();
    expect(scanner.feed("serve em http://localhost:4000\r").map((u) => u.port)).toEqual(
      [4000],
    );
  });

  it("does not re-report a line it already handed back", () => {
    const scanner = createUrlScanner();
    scanner.feed("http://localhost:3000\n");
    expect(scanner.feed("outra coisa\n")).toEqual([]);
  });

  it("shrugs off an empty chunk", () => {
    expect(createUrlScanner().feed("")).toEqual([]);
  });
});

describe("mergeAdvertised", () => {
  const url = (origin: string): AdvertisedUrl => ({
    origin,
    host: "localhost",
    port: 1,
    kind: "loopback",
    at: 0,
  });

  it("returns the very same array when nothing is new", () => {
    const current = [url("http://localhost:1")];
    expect(mergeAdvertised(current, [])).toBe(current);
    expect(mergeAdvertised(current, [url("http://localhost:1")])).toBe(current);
  });

  it("puts what just appeared first", () => {
    const current = [url("http://localhost:1")];
    const next = mergeAdvertised(current, [url("http://localhost:2")]);
    expect(next.map((u) => u.origin)).toEqual(["http://localhost:2", "http://localhost:1"]);
  });

  it("keeps several new ones in the order they were printed", () => {
    const next = mergeAdvertised([], [url("http://a:1"), url("http://b:2")]);
    expect(next.map((u) => u.origin)).toEqual(["http://a:1", "http://b:2"]);
  });

  it("drops the oldest past the cap", () => {
    const current = [url("http://localhost:1"), url("http://localhost:2")];
    const next = mergeAdvertised(current, [url("http://localhost:3")], 2);
    expect(next.map((u) => u.origin)).toEqual(["http://localhost:3", "http://localhost:1"]);
  });
});

describe("groupAdvertised", () => {
  const url = (origin: string, at = 0): AdvertisedUrl => ({
    origin,
    host: "localhost",
    port: 1,
    kind: "loopback",
    at,
  });
  /** Terminal ids are named after their group: `g1-a` lives in `g1`. */
  const groupOf = (terminalId: string) => terminalId.split("-")[0];

  it("offers a sibling's address to every CLI of the group", () => {
    const byTerminal = { "g1-a": [url("http://localhost:3000")], "g1-b": [] };
    const out = groupAdvertised(byTerminal, groupOf, "g1");
    expect(out.map((u) => u.origin)).toEqual(["http://localhost:3000"]);
  });

  it("ignores what another group is serving", () => {
    const byTerminal = {
      "g1-a": [url("http://localhost:3000")],
      "g2-a": [url("http://localhost:4000")],
    };
    expect(groupAdvertised(byTerminal, groupOf, "g1").map((u) => u.origin)).toEqual([
      "http://localhost:3000",
    ]);
  });

  it("says each address once, newest first", () => {
    const byTerminal = {
      "g1-a": [url("http://localhost:3000", 10)],
      "g1-b": [url("http://localhost:3000", 20), url("http://localhost:5173", 30)],
    };
    expect(groupAdvertised(byTerminal, groupOf, "g1").map((u) => u.origin)).toEqual([
      "http://localhost:5173",
      "http://localhost:3000",
    ]);
  });

  it("keeps the printed order inside the same announcement", () => {
    const byTerminal = {
      "g1-a": [url("http://localhost:5173", 5), url("http://192.168.0.2:5173", 5)],
    };
    expect(groupAdvertised(byTerminal, groupOf, "g1").map((u) => u.origin)).toEqual([
      "http://localhost:5173",
      "http://192.168.0.2:5173",
    ]);
  });

  it("returns the very same array when nothing moved", () => {
    const byTerminal = { "g1-a": [url("http://localhost:3000")] };
    const current = groupAdvertised(byTerminal, groupOf, "g1");
    expect(groupAdvertised(byTerminal, groupOf, "g1", current)).toBe(current);
  });

  it("forgets what a terminal took with it when it died", () => {
    const before = { "g1-a": [url("http://localhost:3000")] };
    const current = groupAdvertised(before, groupOf, "g1");
    expect(groupAdvertised({}, groupOf, "g1", current)).toEqual([]);
  });
});
