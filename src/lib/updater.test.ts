/**
 * The plugin decides whether the manifest is newer than the binary; the app
 * decides when to ask and what to do with the answer. Those decisions are
 * the ones that fail silently — a check that never fires, a skipped version
 * that keeps nagging, a pre-release treated as an upgrade over the release —
 * so they live here as pure rules.
 */
import { describe, expect, it } from "vitest";

import {
  CHECK_EVERY_MS,
  checkDue,
  isNewer,
  progressLabel,
  shouldOffer,
  updateSummary,
} from "./updater";

describe("isNewer", () => {
  it("orders by major, minor, patch — 0.1.10 comes after 0.1.9", () => {
    expect(isNewer("0.1.0", "0.2.0")).toBe(true);
    expect(isNewer("0.1.9", "0.1.10")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0", "0.1.9")).toBe(false);
  });

  it("treats a pre-release as older than its release, and tolerates a leading v", () => {
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(false);
    expect(isNewer("v0.1.0", "v0.1.1")).toBe(true);
  });

  it("never calls garbage an update", () => {
    expect(isNewer("0.1.0", "latest")).toBe(false);
    expect(isNewer("", "0.2.0")).toBe(false);
  });
});

describe("shouldOffer", () => {
  it("stays quiet about a version the user ignored — until a newer one shows up", () => {
    expect(shouldOffer({ version: "0.2.0", skipVersion: "0.2.0", manual: false })).toBe(false);
    expect(shouldOffer({ version: "0.2.1", skipVersion: "0.2.0", manual: false })).toBe(true);
    expect(shouldOffer({ version: "0.2.0", skipVersion: null, manual: false })).toBe(true);
  });

  it("a manual check shows the ignored version again — the user asked", () => {
    expect(shouldOffer({ version: "0.2.0", skipVersion: "0.2.0", manual: true })).toBe(true);
  });
});

describe("checkDue", () => {
  it("is due when nothing was ever checked, and again only after the interval", () => {
    expect(checkDue({ lastCheckAt: 0, now: 1_000 })).toBe(true);
    expect(checkDue({ lastCheckAt: 1_000, now: 1_000 + CHECK_EVERY_MS - 1 })).toBe(false);
    expect(checkDue({ lastCheckAt: 1_000, now: 1_000 + CHECK_EVERY_MS })).toBe(true);
  });

  it("a clock that went backwards does not postpone the check forever", () => {
    expect(checkDue({ lastCheckAt: 5_000_000, now: 1_000 })).toBe(true);
  });
});

describe("updateSummary", () => {
  it("names the version and keeps the first lines of the notes", () => {
    const s = updateSummary("0.3.0", "## Novidades\n\n- Bandeja\n- Tema claro\n- Atualizador\n- Mais\n");
    expect(s.title).toBe("Versão 0.3.0 disponível");
    expect(s.notes).toEqual(["Novidades", "Bandeja", "Tema claro"]);
  });

  it("has no notes when the release body is empty", () => {
    expect(updateSummary("0.3.0", undefined).notes).toEqual([]);
  });
});

describe("progressLabel", () => {
  it("shows a percentage while the size is known, kilobytes when it is not", () => {
    expect(progressLabel("downloading", { downloaded: 400, total: 1000 })).toBe("Baixando… 40%");
    expect(progressLabel("downloading", { downloaded: 2048, total: null })).toBe("Baixando… 2 KB");
  });

  it("says the app will reopen on its own once the installer runs", () => {
    expect(progressLabel("installing", { downloaded: 1000, total: 1000 })).toContain("reabrir");
    expect(progressLabel("available", { downloaded: 0, total: null })).toBeNull();
  });
});
