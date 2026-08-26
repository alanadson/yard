/**
 * The stores and hooks raise the sentences nobody clicks for — the native
 * balloon when an agent stops, the toast when a backup or a language server
 * fails, the default names a new group or prompt is born with. Each one is
 * produced through `t()` at the moment it is shown, so each needs its English
 * line: a missing one would put a Portuguese balloon on an English desktop.
 */
import { describe, expect, it } from "vitest";

import stores from "./stores";

const MUST_HAVE = [
  "{title} está esperando você: {ask}",
  "{title} está esperando você em {project}: {ask}",
  "{title} terminou.",
  "{title} terminou em {project}.",
  "Backup automático gravado ({kb} KB).",
  "Backup automático falhou: {reason}",
  "Não consegui iniciar {program}: {reason}",
  "Abra um grupo antes de pôr as anotações numa aba.",
  "Grupo {n}",
  "Sem título",
  "Yard — gatilho",
];

describe("stores and hooks in English", () => {
  it("every sentence the stores and hooks raise has its English line", () => {
    for (const text of MUST_HAVE) {
      expect(stores[text as keyof typeof stores], `"${text}"`).toBeTruthy();
    }
  });
});
