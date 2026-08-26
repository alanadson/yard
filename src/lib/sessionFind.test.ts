/**
 * Which session on disk belongs to a terminal. Sessions are listed by
 * folder, not by terminal — two CLIs in the same project write two trails
 * there — so the only certain link is the id a resumed terminal carries in
 * its command line; without it, the newest trail is the best guess.
 */
import { describe, expect, it } from "vitest";

import type { AgentSession } from "./ipc";
import { bestSessionFor } from "./sessionFind";

const s = (externalId: string, updatedAt: number): AgentSession => ({
  agent: "claude",
  externalId,
  projectPath: "C:\\proj",
  title: null,
  updatedAt,
  sizeBytes: 1,
  file: `C:\\sessions\\${externalId}.jsonl`,
});

describe("bestSessionFor", () => {
  it("the session named in the resume arguments wins over the newest", () => {
    const list = [s("newest", 30), s("resumed", 10)];
    expect(bestSessionFor(list, ["--resume", "resumed"])?.externalId).toBe("resumed");
  });

  it("otherwise the newest one — the backend lists newest first", () => {
    const list = [s("newest", 30), s("older", 10)];
    expect(bestSessionFor(list, [])?.externalId).toBe("newest");
    expect(bestSessionFor(list, null)?.externalId).toBe("newest");
  });

  it("nothing when there is nothing on disk", () => {
    expect(bestSessionFor([], ["--resume", "x"])).toBeNull();
  });
});
