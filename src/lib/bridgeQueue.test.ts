/**
 * Why these rules matter: `yard ask --queue` is the one call in the bridge
 * that succeeds *without* the other agent having read anything. The answer
 * has to say that plainly — an agent told "enviado" for a prompt still
 * sitting in a queue will go on to `yard wait` for a reply that is not
 * coming, and burn its timeout doing it.
 */
import { describe, expect, it } from "vitest";

import { formatQueue, queuedLine } from "./bridgeQueue";
import type { QueueItem } from "./queue";

const item = (id: string, terminalId: string, text: string): QueueItem => ({
  id,
  terminalId,
  text,
  at: 0,
  source: "bridge",
});

describe("queuedLine", () => {
  it("says it was parked, not sent, and where in the line it is", () => {
    const line = queuedLine("claude", 2);
    expect(line).toContain("claude");
    expect(line).toContain("2");
    expect(line.toLowerCase()).toContain("fila");
    expect(line).not.toContain("enviado");
  });

  it("reads naturally when it is the next one in", () => {
    expect(queuedLine("claude", 1)).toContain("próximo");
  });

  it("ends with a newline — it is written into a terminal", () => {
    expect(queuedLine("claude", 1).endsWith("\n")).toBe(true);
  });
});

describe("formatQueue", () => {
  const items = [
    item("1", "t1", "rodar os testes"),
    item("2", "t1", "abrir o PR"),
    item("3", "t2", "revisar o diff"),
  ];
  const nameOf = (id: string) => (id === "t1" ? "claude" : "codex");

  it("lists each terminal's queue in order, numbered", () => {
    const out = formatQueue(items, nameOf);
    expect(out).toContain('"claude"');
    expect(out).toContain("1. rodar os testes");
    expect(out).toContain("2. abrir o PR");
    expect(out).toContain('"codex"');
    expect(out).toContain("1. revisar o diff");
  });

  /** A long prompt is a paragraph; the list has to stay a list. */
  it("shortens a long prompt to its first line", () => {
    const long = item("4", "t1", "primeira linha\nsegunda linha");
    expect(formatQueue([long], nameOf)).not.toContain("segunda linha");
  });

  it("says plainly when nothing is queued", () => {
    expect(formatQueue([], nameOf)).toContain("Nada na fila");
  });

  it("ends with a newline", () => {
    expect(formatQueue(items, nameOf).endsWith("\n")).toBe(true);
    expect(formatQueue([], nameOf).endsWith("\n")).toBe(true);
  });
});
