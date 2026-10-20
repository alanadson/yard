/** A slow archive preview must never replace the session the user selected later. */
import { afterEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ ptyArchives: vi.fn(), ptyArchivePreview: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: native }));
import { useOutputHistory } from "./outputHistoryStore";

afterEach(() => { vi.clearAllMocks(); useOutputHistory.setState({ records: [], selected: null, preview: null, error: null, loading: false, previewLoading: false }); });

it("keeps the latest selected session when its earlier preview finishes later", async () => {
  const first = { terminalId: "terminal", name: "terminal--1000--0.bin", at: 1000, bytes: 14 };
  const latest = { ...first, name: "terminal--2000--0.bin", at: 2000 };
  useOutputHistory.setState({ records: [first, latest] });
  let earlier!: (value: { text: string; bytes: number; truncated: boolean }) => void;
  native.ptyArchivePreview.mockReturnValueOnce(new Promise((resolve) => { earlier = resolve; }));
  native.ptyArchivePreview.mockResolvedValueOnce({ text: "Latest output", bytes: 14, truncated: false });
  const pending = useOutputHistory.getState().select(first);
  await useOutputHistory.getState().select(latest);
  earlier({ text: "Earlier output", bytes: 14, truncated: false });
  await pending;
  expect(useOutputHistory.getState().selected).toEqual(latest);
  expect(useOutputHistory.getState().preview?.text).toBe("Latest output");
});

it("loading another terminal replaces the list and discards the previous terminal's pending preview", async () => {
  const previous = { terminalId: "previous", name: "previous--1000--0.bin", at: 1000, bytes: 14 };
  const current = { ...previous, terminalId: "current", name: "current--2000--0.bin", at: 2000 };
  useOutputHistory.setState({ records: [previous] });
  let earlier!: (value: { text: string; bytes: number; truncated: boolean }) => void;
  native.ptyArchivePreview.mockReturnValueOnce(new Promise((resolve) => { earlier = resolve; }));
  native.ptyArchives.mockResolvedValueOnce([current]);
  native.ptyArchivePreview.mockResolvedValueOnce({ text: "Current terminal output", bytes: 14, truncated: false });
  const pending = useOutputHistory.getState().select(previous);
  await useOutputHistory.getState().load("current");
  earlier({ text: "Previous terminal output", bytes: 14, truncated: false });
  await pending;
  expect(useOutputHistory.getState().records).toEqual([current]);
  expect(useOutputHistory.getState().selected).toEqual(current);
  expect(useOutputHistory.getState().preview?.text).toBe("Current terminal output");
});
