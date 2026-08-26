import { describe, expect, it } from "vitest";

import { fileSize, mediaKind, mediaUrl } from "./media";

describe("mediaKind", () => {
  it("groups what the screen knows how to draw", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("image/svg+xml")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("audio/mpeg")).toBe("audio");
    expect(mediaKind("application/pdf")).toBe("pdf");
  });

  it("does not invent a face for the rest", () => {
    expect(mediaKind(null)).toBeNull();
    expect(mediaKind(undefined)).toBeNull();
    expect(mediaKind("application/zip")).toBeNull();
    expect(mediaKind("text/plain")).toBeNull();
  });
});

describe("mediaUrl", () => {
  it("carries root and path escaped in the query", () => {
    const url = mediaUrl("C:\\Workspace\\Code\\projeto", "public/assets/mamãe & cia.png");
    const query = new URL(url).searchParams;
    expect(query.get("root")).toBe("C:\\Workspace\\Code\\projeto");
    expect(query.get("path")).toBe("public/assets/mamãe & cia.png");
    // The `&` in the name must not turn into another parameter.
    expect(query.get("cia.png")).toBeNull();
  });

  // The backend reads percent escapes and nothing else — a `+` there is the
  // character `+`, not a space. Anything that writes the form encoding turns
  // every photo with a space in its name into a 404.
  it("escapes the space as %20, never as +", () => {
    const url = mediaUrl("C:\\Users\\Ana Maria\\projeto", "public/foto de perfil.png");
    expect(url).not.toContain("+");
    expect(url).toContain("Ana%20Maria");
    expect(url).toContain("foto%20de%20perfil.png");
  });

  it("changes when the file changes on disk", () => {
    const before = mediaUrl("C:/p", "a.png", 1000);
    const after = mediaUrl("C:/p", "a.png", 2000);
    expect(before).not.toBe(after);
    // With no stamp, no stray parameter is left behind.
    expect(mediaUrl("C:/p", "a.png")).not.toContain("v=");
  });
});

describe("fileSize", () => {
  it("speaks the unit the number calls for", () => {
    expect(fileSize(0)).toBe("0 B");
    expect(fileSize(840)).toBe("840 B");
    expect(fileSize(1024)).toBe("1 KB");
    expect(fileSize(1024 * 934)).toBe("934 KB");
    expect(fileSize(1024 * 1024 * 18.4)).toBe("18,4 MB");
    expect(fileSize(1024 ** 3 * 2.5)).toBe("2,5 GB");
  });
});

/**
 * The decimal separator follows the interface language: "18,4 MB" in
 * Portuguese, "18.4 MB" in English — a comma in an English sentence reads as
 * a thousands separator and turns 18.4 into eighteen thousand.
 */
describe("fileSize in English", () => {
  it("writes the decimal with a point", async () => {
    const { setActiveLang } = await import("./i18n");
    setActiveLang("en");
    try {
      expect(fileSize(1024 * 1024 * 18.4)).toBe("18.4 MB");
      expect(fileSize(1024 * 934)).toBe("934 KB");
    } finally {
      setActiveLang("pt-BR");
    }
  });
});
