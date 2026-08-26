/**
 * The catalog side of LSP: which server takes which file, and how a Windows
 * path becomes the `file:///C:/…` URI a language server expects. A wrong URI
 * is the silent kind of bug — the server answers nothing, the editor shows
 * nothing, and no error is ever raised.
 */
import { describe, expect, it } from "vitest";

import type { LspServerInfo } from "../ipc";
import { clientKey, fileUri, languageIdFor, rootUri, serverFor } from "./servers";

const server = (program: string, ids: string[], found = true): LspServerInfo => ({
  languageIds: ids,
  program,
  args: ["--stdio"],
  version: found ? "1.0" : null,
  installHint: "npm i -g x",
  found,
});

describe("languageIdFor", () => {
  it("maps the editor's extensions to LSP language ids", () => {
    expect(languageIdFor("src/lib/a.ts")).toBe("typescript");
    expect(languageIdFor("src/App.tsx")).toBe("typescriptreact");
    expect(languageIdFor("scripts/x.mjs")).toBe("javascript");
    expect(languageIdFor("ui/Card.jsx")).toBe("javascriptreact");
    expect(languageIdFor("src-tauri/src/lib.rs")).toBe("rust");
    expect(languageIdFor("tools/gen.py")).toBe("python");
    expect(languageIdFor("cmd/main.go")).toBe("go");
    expect(languageIdFor("src/styles.css")).toBe("css");
    expect(languageIdFor("theme.scss")).toBe("scss");
    expect(languageIdFor("index.html")).toBe("html");
    expect(languageIdFor("package.json")).toBe("json");
    expect(languageIdFor("C:\\repo\\tsconfig.jsonc")).toBe("jsonc");
  });

  it("answers null for what no server in the catalog takes", () => {
    expect(languageIdFor("README.md")).toBeNull();
    expect(languageIdFor("Makefile")).toBeNull();
    expect(languageIdFor("notes.TXT")).toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    expect(languageIdFor("Legacy.TS")).toBe("typescript");
  });
});

describe("serverFor", () => {
  const detected = [
    server("typescript-language-server", ["typescript", "javascript"]),
    server("rust-analyzer", ["rust"], false),
  ];

  it("picks the installed server that lists the language", () => {
    expect(serverFor("javascript", detected)?.program).toBe("typescript-language-server");
  });

  it("never offers a server the machine does not have", () => {
    expect(serverFor("rust", detected)).toBeNull();
  });

  it("answers null for a language nobody serves", () => {
    expect(serverFor("haskell", detected)).toBeNull();
  });
});

describe("fileUri / rootUri", () => {
  it("turns a Windows root and a relative path into a file URI with forward slashes", () => {
    expect(fileUri("C:\\Workspace\\Code\\yard", "src/lib/a.ts")).toBe(
      "file:///C:/Workspace/Code/yard/src/lib/a.ts",
    );
    expect(rootUri("C:\\Workspace\\Code\\yard")).toBe("file:///C:/Workspace/Code/yard");
  });

  it("percent-encodes spaces and reserved characters but not the drive colon", () => {
    expect(fileUri("C:\\My Projects\\app", "src\\a b#1.ts")).toBe(
      "file:///C:/My%20Projects/app/src/a%20b%231.ts",
    );
  });

  it("tolerates a trailing separator on the root and a leading one on the path", () => {
    expect(fileUri("C:/repo/", "/src/x.rs")).toBe("file:///C:/repo/src/x.rs");
  });

  it("uses an absolute path as is when one is handed over", () => {
    expect(fileUri("C:\\repo", "D:\\other\\y.py")).toBe("file:///D:/other/y.py");
  });

  it("keeps unicode readable in the encoded form", () => {
    expect(fileUri("C:/repo", "docs/ação.ts")).toBe("file:///C:/repo/docs/a%C3%A7%C3%A3o.ts");
  });
});

describe("clientKey", () => {
  it("is the same for the same root spelled with different separators or case of drive", () => {
    expect(clientKey("C:\\repo\\", "rust-analyzer")).toBe(clientKey("c:/repo", "rust-analyzer"));
  });

  it("differs by server program", () => {
    expect(clientKey("C:/repo", "rust-analyzer")).not.toBe(
      clientKey("C:/repo", "typescript-language-server"),
    );
  });
});
