/**
 * The store is the only thing standing between the timer and the disk: it
 * hands the backend the folder and the retention the user chose, remembers
 * when the last copy was made (in the kv, so a reload does not restart the
 * calendar), and refuses to run twice at once — two overlapping exports
 * would fight over the same zip name and the same database lock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { backupAutoRun } = vi.hoisted(() => ({
  backupAutoRun: vi.fn(async (_dir: string | null, _keep: number) => ({
    path: "D:\\bk\\yard-auto-2026-08-26-0417.zip",
    bytes: 4096,
    pruned: [] as string[],
  })),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { backupAutoRun },
}));

import { KV_LAST_AUTO } from "../lib/autoBackup";
import { setPrefsTransport } from "../lib/prefs";
import { useAutoBackup } from "./autoBackupStore";
import { useUI } from "./uiStore";

const NOW = Date.UTC(2026, 7, 26, 4, 17);

let written: Record<string, string>;
let restore: () => void;

beforeEach(() => {
  written = {};
  restore?.();
  restore = setPrefsTransport({
    readPrefs: async () => ({}),
    writePref: async (key, value) => {
      written[key] = value;
    },
  });
  backupAutoRun.mockClear();
  useAutoBackup.setState({ lastAutoAt: 0, running: false, lastError: null });
  useUI.setState((s) => ({
    prefs: { ...s.prefs, autoBackupDir: "D:\\bk", autoBackupKeep: 3 },
    toasts: [],
  }));
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("autoBackupStore", () => {
  it("load reads the stamp from the kv snapshot and tolerates garbage", () => {
    useAutoBackup.getState().load({ [KV_LAST_AUTO]: String(NOW) });
    expect(useAutoBackup.getState().lastAutoAt).toBe(NOW);
    useAutoBackup.getState().load({ [KV_LAST_AUTO]: "ontem" });
    expect(useAutoBackup.getState().lastAutoAt).toBe(0);
    useAutoBackup.getState().load({});
    expect(useAutoBackup.getState().lastAutoAt).toBe(0);
  });

  it("runNow hands the backend the chosen folder and retention, then records the stamp in the store and the kv", async () => {
    const report = await useAutoBackup.getState().runNow({ auto: true, now: NOW });
    expect(report?.bytes).toBe(4096);
    expect(backupAutoRun).toHaveBeenCalledWith("D:\\bk", 3);
    expect(useAutoBackup.getState().lastAutoAt).toBe(NOW);
    await flush();
    expect(written[KV_LAST_AUTO]).toBe(String(NOW));
    expect(useAutoBackup.getState().running).toBe(false);
  });

  it("an empty folder preference means the default folder — null to the backend", async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, autoBackupDir: "  " } }));
    await useAutoBackup.getState().runNow({ auto: true, now: NOW });
    expect(backupAutoRun).toHaveBeenCalledWith(null, 3);
  });

  it("two overlapping runs make a single backend call", async () => {
    let release: () => void = () => {};
    backupAutoRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ path: "x.zip", bytes: 1, pruned: [] });
        }),
    );
    const first = useAutoBackup.getState().runNow({ auto: true, now: NOW });
    const second = await useAutoBackup.getState().runNow({ auto: true, now: NOW });
    expect(second).toBeNull();
    release();
    await first;
    expect(backupAutoRun).toHaveBeenCalledTimes(1);
  });

  it("a failed run keeps the previous stamp, remembers the error and raises an error toast", async () => {
    useAutoBackup.setState({ lastAutoAt: NOW - 1000 });
    backupAutoRun.mockRejectedValueOnce(new Error("disco cheio"));
    const report = await useAutoBackup.getState().runNow({ auto: true, now: NOW });
    expect(report).toBeNull();
    expect(useAutoBackup.getState().lastAutoAt).toBe(NOW - 1000);
    expect(useAutoBackup.getState().lastError).toContain("disco cheio");
    expect(useUI.getState().toasts.some((t) => t.kind === "error")).toBe(true);
    await flush();
    expect(written[KV_LAST_AUTO]).toBeUndefined();
  });

  it("an automatic run is silent on success; a manual one says what it wrote", async () => {
    await useAutoBackup.getState().runNow({ auto: true, now: NOW });
    expect(useUI.getState().toasts).toHaveLength(0);
    await useAutoBackup.getState().runNow({ auto: false, now: NOW });
    expect(useUI.getState().toasts.map((t) => t.message)).toEqual([
      "Backup automático gravado (4 KB).",
    ]);
  });
});
