/**
 * Two things are worth pinning down here: that a workspace saved before roles
 * had instructions still loads (the string form is everywhere on disk), and
 * that the launch decides exactly one delivery channel — a role handed over
 * twice would tell the agent to be itself twice.
 */
import { describe, expect, it } from "vitest";

import {
  normalizePresets,
  normalizeRole,
  normalizeRoles,
  roleFromText,
  ROLE_NAME_MAX,
} from "./canvas";
import { briefingFor, mergeRoles, roleLaunch, withoutArgs } from "./roles";

describe("roleFromText", () => {
  it("a short single line becomes just a name — the old form, and a label is not an instruction", () => {
    expect(roleFromText("revisora")).toEqual({ name: "revisora" });
    expect(roleFromText("   ")).toBeUndefined();
  });

  it("long text keeps everything and uses the first line as the name", () => {
    const role = roleFromText("Revisora de PR\nNão escreve código, só aponta.")!;
    expect(role.name).toBe("Revisora de PR");
    expect(role.text).toContain("Não escreve código");
  });

  it("a single-line name that is too long gets cut with an ellipsis", () => {
    const role = roleFromText("x".repeat(120))!;
    expect(role.name).toHaveLength(ROLE_NAME_MAX);
    expect(role.name.endsWith("…")).toBe(true);
    expect(role.text).toHaveLength(120);
  });
});

describe("normalizeRole", () => {
  it("accepts the string from old boards and today's object", () => {
    expect(normalizeRole("revisora")).toEqual({ name: "revisora" });
    expect(normalizeRole({ name: "R", text: "faça x" })).toEqual({
      name: "R",
      text: "faça x",
    });
  });

  it("drops text equal to the name — storing it twice bloats every save", () => {
    expect(normalizeRole({ name: "R", text: "R" })).toEqual({ name: "R" });
  });

  it("with no name, falls back to the text; with nothing, disappears", () => {
    expect(normalizeRole({ text: "revisa tudo" })).toEqual({ name: "revisa tudo" });
    expect(normalizeRole({ name: "  " })).toBeUndefined();
    expect(normalizeRoles({ t1: "", t2: "ok" })).toEqual({ t2: { name: "ok" } });
    expect(normalizeRoles({ t1: 7 })).toBeUndefined();
  });
});

describe("normalizePresets", () => {
  it("a string becomes {text}, and the color survives when present", () => {
    expect(normalizePresets({ A: "texto", B: { text: "outro", color: "#fff" } })).toEqual({
      A: { text: "texto" },
      B: { text: "outro", color: "#fff" },
    });
  });

  it("an entry with no text does not make it into the library", () => {
    expect(normalizePresets({ A: "  ", B: { color: "#fff" } })).toBeUndefined();
  });
});

describe("mergeRoles", () => {
  it("the group's one comes first and hides the global one with the same name", () => {
    const list = mergeRoles(
      { Zelda: { text: "do grupo" } },
      { Zelda: { text: "global" }, Ana: { text: "global" } },
    );
    expect(list.map((r) => [r.name, r.scope, r.text])).toEqual([
      ["Zelda", "current", "do grupo"],
      ["Ana", "global", "global"],
    ]);
  });
});

describe("roleLaunch", () => {
  it("a CLI with a flag gets the flag and no message", () => {
    const out = roleLaunch("claude", { name: "R", text: "seja breve" });
    expect(out.args).toEqual(["--append-system-prompt", "seja breve"]);
    expect(out.briefing).toBeNull();
  });

  it("a CLI without a flag gets the message and no argument", () => {
    const out = roleLaunch("codex", { name: "R", text: "seja breve" });
    expect(out.args).toEqual([]);
    expect(out.briefing).toContain("seja breve");
    expect(out.briefing).toContain('"R"');
  });

  it("a role with no instructions delivers nothing — it is a card label", () => {
    expect(roleLaunch("claude", { name: "revisora" })).toEqual({
      args: [],
      briefing: null,
    });
    expect(roleLaunch("claude", undefined).briefing).toBeNull();
  });
});

describe("withoutArgs", () => {
  it("removes the exact sequence and leaves the rest untouched", () => {
    expect(
      withoutArgs(["--model", "opus", "--append-system-prompt", "x", "--verbose"], [
        "--append-system-prompt",
        "x",
      ]),
    ).toEqual(["--model", "opus", "--verbose"]);
  });

  it("does not touch anything when the sequence is not there", () => {
    const args = ["--append-system-prompt", "outro"];
    expect(withoutArgs(args, ["--append-system-prompt", "x"])).toEqual(args);
    expect(withoutArgs(args, [])).toEqual(args);
  });
});

describe("briefingFor", () => {
  it("frames the instructions as a standing rule, not as a task", () => {
    const theText = briefingFor({ name: "Revisora", text: "não escreva código" });
    expect(theText).toContain("Papel deste terminal");
    expect(theText).toContain("não escreva código");
    expect(theText).toContain("toda a sessão");
  });
});
