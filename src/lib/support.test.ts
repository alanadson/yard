/**
 * The support bundle is what a user attaches to a public issue. The file name
 * and the issue skeleton are the two pieces of text the user sees before
 * anything leaves the machine, so both are pinned here: a name that sorts by
 * time, and a skeleton that asks for the three things a maintainer needs.
 */
import { describe, expect, it } from "vitest";

import { bundleFileName, issueBody, TRACKER_URL } from "./support";

describe("bundleFileName", () => {
  it("stamps local date and time, zero-padded, so bundles sort by creation", () => {
    expect(bundleFileName(new Date(2026, 7, 26, 4, 7))).toBe("yard-suporte-2026-08-26-0407.zip");
    expect(bundleFileName(new Date(2026, 11, 1, 23, 59))).toBe("yard-suporte-2026-12-01-2359.zip");
  });
});

describe("issueBody", () => {
  it("asks for what happened and the steps, and says which bundle to attach", () => {
    const body = issueBody({ version: "0.1.0", bundleName: "yard-suporte-2026-08-26-0407.zip" });
    expect(body).toContain("Versão: 0.1.0");
    expect(body).toContain("O que aconteceu:");
    expect(body).toContain("Passos:");
    expect(body).toContain("yard-suporte-2026-08-26-0407.zip");
  });

  it("still reads as a checklist when no bundle was generated yet", () => {
    const body = issueBody({});
    expect(body).toContain("Versão: —");
    expect(body).toContain("Anexe o pacote");
    expect(body).not.toContain("undefined");
  });
});

describe("TRACKER_URL", () => {
  it("points at the new-issue page of the public tracker", () => {
    expect(TRACKER_URL).toBe("https://github.com/alanadson/yard/issues/new");
  });
});
