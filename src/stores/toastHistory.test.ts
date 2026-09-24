// Bursts of routine or Git notices must leave actionable errors available for review.
import { afterEach, expect, it, vi } from "vitest";
import { useUI } from "./uiStore";
afterEach(() => {
  vi.useRealTimers();
  useUI.getState().dismissToast();
});

it("keeps errors ahead of transient notices and retains a bounded history after dismissal", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  useUI.setState({ toasts: [], toastHistory: [], toastOverflow: 0 });
  useUI.getState().showToast("merge failed", "error", "project / feature");
  for (const message of ["one", "two", "three"])
    useUI.getState().showToast(message);
  expect(useUI.getState().toasts.map((toast) => toast.message)).toContain(
    "merge failed",
  );
  useUI.getState().dismissToast();
  expect(useUI.getState().toastHistory[0]).toMatchObject({
    message: "merge failed",
    source: "project / feature",
    createdAt: 1_000,
  });
  for (let index = 0; index < 110; index++)
    useUI.getState().showToast(`failure ${index}`, "error");
  expect(useUI.getState().toastHistory).toHaveLength(100);
  expect(useUI.getState().toastHistory.at(-1)?.message).toBe("failure 109");
});
