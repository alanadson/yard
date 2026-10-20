/** Long histories must expand without removing the sessions the user already saw. */
import { expect, it } from "vitest";
import { archivePage, retentionCandidates } from "./outputHistory";

it("expands a long archive list while preserving every record from its first page", () => {
  const records = Array.from({ length: 205 }, (_, n) => ({ terminalId: "terminal", name: `terminal--1000--${n}.bin`, at: 1000, bytes: 10 }));
  const first = archivePage(records, 200);
  expect(first.records).toEqual(records.slice(0, 200));
  expect(first.nextLimit).toBe(205);
  const next = archivePage(records, first.nextLimit!);
  expect(next.records).toEqual(records);
  expect(next.nextLimit).toBeNull();
});

it("selects only archives strictly older than the explicit retention period", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 120 * day;
  const record = (at: number) => ({ terminalId: "terminal", name: `terminal--${at}--0.bin`, at, bytes: 10 });
  const old = record(10 * day);
  const boundary = record(90 * day);
  const recent = record(100 * day);
  const future = record(130 * day);
  expect(retentionCandidates([old, boundary, recent, future], 30, now)).toEqual([old]);
});

it("keeps every archived session when no retention period was selected", () => {
  const records = [{ terminalId: "terminal", name: "terminal--1000--0.bin", at: 1000, bytes: 10 }];
  expect(retentionCandidates(records, 0, 100 * 24 * 60 * 60 * 1000)).toEqual([]);
});
