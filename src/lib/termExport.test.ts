/**
 * The save dialog is the only question the export asks, so the file name
 * the user picks has to carry both answers: *where* and *which shape*. A
 * `.txt` that came out full of `ESC[?25l` — or an `.ansi` with the colors
 * stripped — is a dialog that lied.
 */
import { describe, expect, it } from "vitest";

import { exportFileName, exportModeFor } from "./termExport";

describe("exportModeFor", () => {
  it("saves plain text for .txt, .md and a name with no extension", () => {
    expect(exportModeFor("C:\\tmp\\saida.txt")).toBe("plain");
    expect(exportModeFor("/home/x/notas.md")).toBe("plain");
    expect(exportModeFor("C:\\tmp\\saida")).toBe("plain");
  });

  it("keeps the escapes for .ansi and .log — the shapes a terminal replays", () => {
    expect(exportModeFor("C:\\tmp\\saida.ansi")).toBe("raw");
    expect(exportModeFor("C:\\tmp\\saida.log")).toBe("raw");
  });

  it("is not fooled by case or by a dot in a folder name", () => {
    expect(exportModeFor("C:\\tmp\\Saida.TXT")).toBe("plain");
    expect(exportModeFor("C:\\v1.2\\saida")).toBe("plain");
    expect(exportModeFor("C:\\v1.2\\saida.ANSI")).toBe("raw");
  });
});

describe("exportFileName", () => {
  const at = new Date(2026, 7, 26, 4, 7); // 2026-08-26 04:07 local

  it("stamps the terminal's name with the date and time, as .txt", () => {
    expect(exportFileName("claude", at)).toBe("claude-2026-08-26-0407.txt");
  });

  it("replaces what a file system refuses and trims the rest", () => {
    expect(exportFileName("api: build/watch?", at)).toBe("api-build-watch-2026-08-26-0407.txt");
    expect(exportFileName("  espaços   duplos  ", at)).toBe("espaços-duplos-2026-08-26-0407.txt");
  });

  it("falls back to a generic name when nothing usable is left", () => {
    expect(exportFileName("???", at)).toBe("terminal-2026-08-26-0407.txt");
    expect(exportFileName("", at)).toBe("terminal-2026-08-26-0407.txt");
  });
});
