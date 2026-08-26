/**
 * What the catalog row says — installed with a version, missing with the
 * install line, or stopped with the reason — is a rule, and the rule is what
 * keeps "não encontrado" from ever showing next to a server that is there.
 */
import { describe, expect, it } from "vitest";

import type { LspServerInfo } from "../../../lib/ipc";
import { serverStatus } from "./LspServers";

const base: LspServerInfo = {
  languageIds: ["rust"],
  program: "rust-analyzer",
  args: [],
  version: "rust-analyzer 1.80",
  installHint: "rustup component add rust-analyzer",
  found: true,
};

describe("serverStatus", () => {
  it("shows the version of an installed server", () => {
    expect(serverStatus(base, undefined)).toEqual({ text: "rust-analyzer 1.80", tone: "ok" });
  });

  it("still calls an installed server installed when it answered no version", () => {
    expect(serverStatus({ ...base, version: null }, undefined)).toEqual({
      text: "instalado (versão desconhecida)",
      tone: "ok",
    });
  });

  it("gives the install line for a missing server", () => {
    const s = serverStatus({ ...base, found: false, version: null }, undefined);
    expect(s.tone).toBe("missing");
    expect(s.text).toContain("rustup component add rust-analyzer");
  });

  it("a failure since the app opened wins over everything else", () => {
    const s = serverStatus(base, "rust-analyzer encerrou (código 101)");
    expect(s).toEqual({ text: "parou: rust-analyzer encerrou (código 101)", tone: "failed" });
  });
});
