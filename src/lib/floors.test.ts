import { describe, expect, it } from "vitest";

import {
  floorHookEnv,
  normalizeFloor,
  parseHookLines,
} from "./floors";

describe("normalizeFloor", () => {
  it("preserva um andar isolado completo", () => {
    const floor = normalizeFloor({
      kind: "isolated",
      branch: "yard/fix-login",
      worktreePath: "C:\\proj\\.yard\\floors\\fix-login",
      hooks: { setup: ["npm ci"], run: ["npm run dev"], teardown: [], autoSetup: true },
    });
    expect(floor).toEqual({
      kind: "isolated",
      branch: "yard/fix-login",
      worktreePath: "C:\\proj\\.yard\\floors\\fix-login",
      hooks: { setup: ["npm ci"], run: ["npm run dev"], teardown: [], autoSetup: true },
    });
  });

  it("descarta kind desconhecido e lixo estrutural", () => {
    expect(normalizeFloor(undefined)).toBeUndefined();
    expect(normalizeFloor(null)).toBeUndefined();
    expect(normalizeFloor("isolated")).toBeUndefined();
    expect(normalizeFloor({ kind: "penthouse" })).toBeUndefined();
    expect(normalizeFloor({ branch: "x" })).toBeUndefined();
  });

  it("limpa campos tortos sem derrubar o resto", () => {
    const floor = normalizeFloor({
      kind: "plain",
      branch: "   ",
      worktreePath: 42,
      hooks: { setup: [1, "ok", ""], run: "npm run dev", teardown: null },
    });
    // Invalid branch/worktreePath disappear; hooks keeps only what is usable.
    expect(floor).toEqual({ kind: "plain", hooks: { setup: ["ok"], run: [], teardown: [] } });
  });

  it("hooks totalmente vazios nem entram no objeto", () => {
    const floor = normalizeFloor({ kind: "ground", hooks: { setup: [], run: [], teardown: [] } });
    expect(floor).toEqual({ kind: "ground" });
  });
});

describe("floorHookEnv", () => {
  it("monta as cinco variaveis, com branch vazia quando nao ha", () => {
    const env = floorHookEnv({
      floorName: "fix-login",
      floorPath: "C:\\proj\\.yard\\floors\\fix-login",
      rootPath: "C:\\proj",
      projectName: "Meu Projeto",
    });
    expect(env).toEqual([
      ["YARD_FLOOR_NAME", "fix-login"],
      ["YARD_BRANCH_NAME", ""],
      ["YARD_FLOOR_PATH", "C:\\proj\\.yard\\floors\\fix-login"],
      ["YARD_ROOT_PATH", "C:\\proj"],
      ["YARD_PROJECT_NAME", "Meu Projeto"],
    ]);
  });
});

describe("parseHookLines", () => {
  it("uma linha por comando, sem vazios", () => {
    expect(parseHookLines("npm ci\n\n  npm run build  \n")).toEqual([
      "npm ci",
      "npm run build",
    ]);
  });
});
