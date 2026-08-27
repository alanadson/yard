/**
 * Preferences come from the `kv` table, which stores text and is editable from
 * outside (an imported backup, a file touched by hand). The ranges existed
 * only as the fields' `min`/`max` and as drag limits — interface validation —
 * and a negative `sidebarWidth` came straight in and broke the layout with no
 * way back through the UI itself.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { setPrefsTransport } from "../lib/prefs";
// The sheets, as text: the floor of each panel is a number that lives here
// *and* there, and only a test can keep the two copies honest.
import bootCss from "../styles.css?raw";
import benchCss from "../components/BenchPanel/bench.css?raw";
import changesCss from "../components/ChangesPanel/changes.css?raw";
import {
  BENCH_MAX,
  BENCH_MIN,
  CHANGES_MAX,
  CHANGES_MIN,
  COMPOSER_SCRATCH,
  DEFAULT_PREFS,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampPref,
  useUI,
} from "./uiStore";

describe("clampPref", () => {
  it("clamps panel widths to the range of their splitter", () => {
    expect(clampPref("sidebarWidth", -900)).toBe(SIDEBAR_MIN);
    expect(clampPref("sidebarWidth", 99_999)).toBe(SIDEBAR_MAX);
    expect(clampPref("changesWidth", 10)).toBe(260);
    expect(clampPref("changesWidth", 10_000)).toBe(CHANGES_MAX);
    expect(clampPref("benchWidth", 0)).toBe(BENCH_MIN);
    expect(clampPref("benchWidth", 5_000)).toBe(BENCH_MAX);
  });

  it("clamps font and scrollback to the same limits as the fields", () => {
    expect(clampPref("fontSize", 0)).toBe(8);
    expect(clampPref("fontSize", 400)).toBe(28);
    expect(clampPref("scrollback", -1)).toBe(1000);
    expect(clampPref("scrollback", 10_000_000)).toBe(200_000);
  });

  /**
   * The code editor's metrics were born hard-coded in the CodeMirror theme
   * (12.5px, 1.55) and became preferences: without a range, a `codeFontSize: 0`
   * from a hand-edited backup makes the whole file invisible, and no field on
   * screen is big enough to undo that.
   */
  it("clamps the code editor's metrics to the fields' limits", () => {
    expect(clampPref("codeFontSize", 2)).toBe(9);
    expect(clampPref("codeFontSize", 999)).toBe(32);
    expect(clampPref("codeLineHeight", 0.2)).toBe(1);
    expect(clampPref("codeLineHeight", 9)).toBe(2.4);
    expect(clampPref("codeTabSize", 0)).toBe(1);
    expect(clampPref("codeTabSize", 40)).toBe(8);
  });

  /**
   * The field's step applies to the stored value, not only to the little
   * arrows: without it, a line height typed as 1.5333333 went whole to the
   * `kv` and came back like that in the field at the next boot.
   */
  it("rounds the metric to the field's step before storing", () => {
    expect(clampPref("codeLineHeight", 1.5333333)).toBe(1.55);
    expect(clampPref("codeFontSize", 12.7)).toBe(12.5);
    expect(clampPref("codeTabSize", 3.6)).toBe(4);
  });

  it("lets through what is already in range", () => {
    expect(clampPref("sidebarWidth", 300)).toBe(300);
    expect(clampPref("fontSize", 13)).toBe(13);
  });

  it("leaves alone what is not a number or has no range", () => {
    expect(clampPref("renderer", "webgl")).toBe("webgl");
    expect(clampPref("confirmOnExit", false)).toBe(false);
    expect(clampPref("fontFamily", "Consolas")).toBe("Consolas");
    // A NaN coming from a corrupted kv does not silently become `min`: the
    // code that converts already falls back to the default before reaching
    // here.
    expect(Number.isNaN(clampPref("fontSize", Number.NaN))).toBe(true);
  });
});

/**
 * Writing a prompt used to require a terminal in focus: the library's "open in
 * the composer" refused to do anything without one, and the text had nowhere
 * to live. The draft now always has a slot — the scratch, when there is no
 * destination — and only sending needs a terminal.
 */
describe("composer draft", () => {
  beforeEach(() => {
    useUI.setState({
      composerDrafts: {},
      composerOpen: false,
      composerTargetId: null,
      focusedTerminalId: null,
    });
  });

  it("keeps it in the loose draft when there is no destination and no focus", () => {
    useUI.getState().sendToComposer("revisar o diff");
    expect(useUI.getState().composerDrafts).toEqual({
      [COMPOSER_SCRATCH]: "revisar o diff",
    });
    expect(useUI.getState().composerOpen).toBe(true);
  });

  it("appends to what was already in the same slot, instead of replacing", () => {
    useUI.getState().sendToComposer("primeiro");
    useUI.getState().sendToComposer("segundo");
    expect(useUI.getState().composerDrafts[COMPOSER_SCRATCH]).toBe(
      "primeiro\nsegundo",
    );
  });

  it("uses the focused terminal, and a chosen destination takes precedence", () => {
    useUI.getState().focusTerminal("t-foco", 0);
    useUI.getState().sendToComposer("para o focado");
    expect(useUI.getState().composerDrafts["t-foco"]).toBe("para o focado");

    useUI.getState().setComposerTarget("t-escolhido");
    useUI.getState().sendToComposer("para o escolhido");
    expect(useUI.getState().composerDrafts["t-escolhido"]).toBe(
      "para o escolhido",
    );
  });

  it("focusing a terminal retakes the composer from a destination chosen earlier", () => {
    useUI.getState().setComposerTarget("t-escolhido");
    useUI.getState().focusTerminal("t-outro", 1);
    expect(useUI.getState().composerTargetId).toBeNull();
  });
});

describe("notices (toasts)", () => {
  beforeEach(() => useUI.setState({ toasts: [] }));

  /**
   * It was a single slot: the second message replaced the first. A burst —
   * the routine scheduler emits one notice per routine that failed — showed
   * only the last one, and the others vanished without a trace.
   */
  it("stacks instead of trampling", () => {
    useUI.getState().showToast("primeiro", "error");
    useUI.getState().showToast("segundo", "error");
    expect(useUI.getState().toasts.map((t) => t.message)).toEqual([
      "primeiro",
      "segundo",
    ]);
  });

  it("holds at most three — the oldest gives way", () => {
    for (const m of ["a", "b", "c", "d"]) useUI.getState().showToast(m);
    expect(useUI.getState().toasts.map((t) => t.message)).toEqual(["b", "c", "d"]);
  });

  it("dismissing removes only the notice asked for", () => {
    useUI.getState().showToast("fica");
    useUI.getState().showToast("sai");
    const target = useUI.getState().toasts[1].id;
    useUI.getState().dismissToast(target);
    expect(useUI.getState().toasts.map((t) => t.message)).toEqual(["fica"]);
  });
});

/**
 * Two new switches, and the reason there are two.
 *
 * The **blocked** agent notice shared its preference with the agent that
 * **finished** (`notifyOnFinish`): turning off the "finished" balloon — the
 * first thing anyone does with six CLIs open — killed along with it the one
 * notice that justifies the feature. And the usage-limit meter takes up the
 * whole title bar of whoever uses none of the three accounts, with no door
 * to hide it.
 */
describe("new preferences on the Settings screen", () => {
  beforeEach(() => {
    setPrefsTransport({ readPrefs: async () => ({}), writePref: async () => {} });
  });

  it("the usage meter and the blocked-agent notice are born on", () => {
    expect(DEFAULT_PREFS.usageWidget).toBe(true);
    expect(DEFAULT_PREFS.notifyBlocked).toBe(true);
  });

  it("come back from the kv turned off, each on its own", async () => {
    await useUI.getState().loadPrefs({ usageWidget: "false", notifyBlocked: "false" });
    const prefs = useUI.getState().prefs;
    expect(prefs.usageWidget).toBe(false);
    expect(prefs.notifyBlocked).toBe(false);
    // The "finished" one stays on: they are independent switches.
    expect(prefs.notifyOnFinish).toBe(true);
  });
});

/**
 * Two things that were session-only and should not have been: the collapsed
 * rows of the tree (every boot came back with everything expanded) and the
 * composer draft (closing the app in the middle of a long prompt discarded
 * it, while the editor kept its own). Both live in the same `kv`, which is
 * text and editable from outside — the read never trusts the format.
 */
describe("workbench state that survives the boot", () => {
  const written: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(written)) delete written[k];
    useUI.setState({ treeCollapsed: {}, composerDrafts: {} });
    setPrefsTransport({
      readPrefs: async () => ({ ...written }),
      writePref: async (key, value) => {
        written[key] = value;
      },
    });
  });

  it("remembers which projects were left collapsed", async () => {
    useUI.getState().toggleTreeNode("p1");
    expect(useUI.getState().treeCollapsed).toEqual({ p1: true });

    // A second tap returns the row to the expanded state — and the map only
    // keeps what was deliberately closed.
    useUI.getState().toggleTreeNode("p1");
    expect(useUI.getState().treeCollapsed).toEqual({});
  });

  /**
   * The regression it prevents: "collapse all" in the sidebar menu, done with
   * one `toggleTreeNode` per project, wrote the kv N times — and, worse,
   * *toggled*: what was already closed opened. One pass, one state.
   */
  it("collapses several at once without toggling the ones already closed", () => {
    useUI.setState({ treeCollapsed: { p1: true } });
    useUI.getState().setTreeCollapsed(["p1", "p2"], true);
    expect(useUI.getState().treeCollapsed).toEqual({ p1: true, p2: true });
  });

  it("expanding several removes the keys instead of writing false", () => {
    useUI.setState({ treeCollapsed: { p1: true, p2: true, p3: true } });
    useUI.getState().setTreeCollapsed(["p1", "p2"], false);
    expect(useUI.getState().treeCollapsed).toEqual({ p3: true });
  });

  /**
   * The `kv` holds text, and the conversion back uses the default's type. The
   * line height is the app's first **fractional** preference: a `parseInt`
   * disguised as a conversion would round it to 1 at boot, with no warning.
   */
  it("reads the fractional line height from the kv as a fraction", async () => {
    await useUI.getState().loadPrefs({
      codeLineHeight: "1.8",
      codeFontSize: "16",
      codeLineNumbers: "false",
    });
    const prefs = useUI.getState().prefs;
    expect(prefs.codeLineHeight).toBe(1.8);
    expect(prefs.codeFontSize).toBe(16);
    expect(prefs.codeLineNumbers).toBe(false);
  });

  it("recovers collapsed rows and drafts from a valid kv", async () => {
    await useUI.getState().loadPrefs({
      "ui.treeCollapsed": JSON.stringify({ p1: true, p2: false }),
      "composer.drafts": JSON.stringify({ t1: "meio prompt", t2: "" }),
    });
    // `false` is not "collapsed": absence is the default, and the map only
    // carries what is closed.
    expect(useUI.getState().treeCollapsed).toEqual({ p1: true });
    expect(useUI.getState().composerDrafts).toEqual({ t1: "meio prompt" });
  });

  it("ignores a corrupted kv instead of breaking the boot", async () => {
    await useUI.getState().loadPrefs({
      "ui.treeCollapsed": "não é json",
      "composer.drafts": "[1,2,3]",
    });
    expect(useUI.getState().treeCollapsed).toEqual({});
    expect(useUI.getState().composerDrafts).toEqual({});
  });

  it("discards the draft of a terminal that no longer exists, and keeps the loose one", () => {
    useUI.setState({
      composerDrafts: { t1: "vivo", t9: "orfão", [COMPOSER_SCRATCH]: "solto" },
    });
    useUI.getState().pruneComposerDrafts(new Set(["t1"]));
    expect(useUI.getState().composerDrafts).toEqual({
      t1: "vivo",
      [COMPOSER_SCRATCH]: "solto",
    });
  });
});

/**
 * The enum check used to be spelled for `renderer` alone; the table exists so
 * the next string preference with a fixed vocabulary (theme, language…) is
 * validated by adding a row, not another `else if`.
 */
describe("PREF_ENUMS", () => {
  it("falls back to the default when a kv value is outside the preference's vocabulary", async () => {
    await useUI.getState().loadPrefs({ renderer: "opengl" });
    expect(useUI.getState().prefs.renderer).toBe(DEFAULT_PREFS.renderer);
    await useUI.getState().loadPrefs({ renderer: "webgl" });
    expect(useUI.getState().prefs.renderer).toBe("webgl");
  });
});

/**
 * The appearance is the second string preference with a fixed vocabulary.
 * A `theme: sepia` typed into the kv by hand must not reach `<html>` as an
 * attribute the CSS knows nothing about — the window would stay dark while
 * the setting said otherwise.
 */
describe("theme preference", () => {
  it("keeps the three words it knows and falls back to dark for anything else", async () => {
    await useUI.getState().loadPrefs({ theme: "light" });
    expect(useUI.getState().prefs.theme).toBe("light");
    await useUI.getState().loadPrefs({ theme: "system" });
    expect(useUI.getState().prefs.theme).toBe("system");
    await useUI.getState().loadPrefs({ theme: "sepia" });
    expect(useUI.getState().prefs.theme).toBe("dark");
  });
});

/**
 * The updater's automatic check is opt-out: a fresh install looks for a new
 * release on its own, and the switch in Configurações → Dados turns it off.
 */
describe("autoCheckUpdates", () => {
  it("is on by default and reads a stored 'false' back", async () => {
    expect(DEFAULT_PREFS.autoCheckUpdates).toBe(true);
    await useUI.getState().loadPrefs({ autoCheckUpdates: "false" });
    expect(useUI.getState().prefs.autoCheckUpdates).toBe(false);
  });
});

/**
 * The interface's language is a preference with a fixed vocabulary; an
 * unknown code in the kv (`fr`, a typo) must fall back to the shipped
 * Portuguese, never leak into `lib/i18n.ts`.
 */
describe("language preference", () => {
  it("is Portuguese out of the box and accepts en / system", async () => {
    expect(DEFAULT_PREFS.lang).toBe("pt-BR");
    await useUI.getState().loadPrefs({ lang: "en" });
    expect(useUI.getState().prefs.lang).toBe("en");
    await useUI.getState().loadPrefs({ lang: "system" });
    expect(useUI.getState().prefs.lang).toBe("system");
  });

  it("falls back to Portuguese for a language the app does not speak", async () => {
    await useUI.getState().loadPrefs({ lang: "fr" });
    expect(useUI.getState().prefs.lang).toBe("pt-BR");
  });
});

/**
 * The floor of each lateral panel is written **twice**: here, as the number
 * `App` subtracts from the window to decide which panel to collapse when it
 * gets narrow, and again in the panel's own sheet as `min-width`. Nothing but
 * a comment ties the two copies together, and the bench had already drifted
 * once — its slot spent 20px of ambient on the floating glass's gutter, so
 * the constant carried `248 + 20` while the sheet carried `268`, and the
 * narrowest bench was 20px narrower than the one the number was measured for.
 *
 * The shell is seamless now: no panel spends the window's ground on a gutter,
 * every separation is a hairline. These two tests are what keeps that true —
 * the slot the user drags *is* the panel, and the two copies of the floor
 * stay the same number.
 */
describe("panel floors", () => {
  /** The body of the first rule whose selector is exactly `selector`. */
  function block(css: string, selector: string): string {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const r of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (r[1].trim().replace(/\s+/g, " ") === selector) return r[2];
    }
    throw new Error(`the ${selector} rule is gone`);
  }

  const px = (body: string, prop: string): number | null => {
    const m = new RegExp(String.raw`(?:^|;)\s*${prop}:\s*(-?[\d.]+)px`).exec(body);
    return m ? Number(m[1]) : null;
  };

  /** What the slot spends on left+right padding before the panel starts. */
  function sideGutter(body: string): number {
    const short = /(?:^|;)\s*padding:\s*([^;]+)/.exec(body);
    if (short) {
      const parts = short[1].trim().split(/\s+/);
      const left = parts[3] ?? parts[1] ?? parts[0];
      const right = parts[1] ?? parts[0];
      return [left, right].reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
    }
    return (px(body, "padding-left") ?? 0) + (px(body, "padding-right") ?? 0);
  }

  it("reads the floor and the gutter out of a rule", () => {
    const css = ".x { min-width: 268px; padding: 10px 4px }\n.x-y { min-width: 9px }";
    expect(px(block(css, ".x"), "min-width")).toBe(268);
    expect(sideGutter(block(css, ".x"))).toBe(8);
    expect(sideGutter(".color: red")).toBe(0);
  });

  it("the bench's slot is all panel — it spends nothing on a gutter of ambient", () => {
    const bench = block(benchCss, ".bench");
    expect(sideGutter(bench)).toBe(0);
    expect(px(bench, "min-width")).toBe(BENCH_MIN);
  });

  it.each([
    ["sidebar", ".sidebar", SIDEBAR_MIN],
    ["changes", ".changes", CHANGES_MIN],
    ["bench", ".bench", BENCH_MIN],
  ])("the %s floor in the sheet is the number the collapse math subtracts", (_name, selector, min) => {
    const css = selector === ".sidebar" ? bootCss : selector === ".changes" ? changesCss : benchCss;
    expect(px(block(css, selector), "min-width")).toBe(min);
  });
});
