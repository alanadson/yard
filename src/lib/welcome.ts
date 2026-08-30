/**
 * The first screen's call to action.
 *
 * The workspace shows this screen whenever no group is open, and it wears two
 * faces: a fresh install, which has no folder to run anything in, and an
 * install with projects where the sidebar simply has nothing selected. Each
 * face gets exactly one button, and they are not the same button — see
 * `welcome.test.ts` for why offering "Nova aba" with zero projects is a walk
 * back to "Adicionar projeto".
 */

export type WelcomeAction =
  /** Opens the "Adicionar projeto" dialog. */
  | "new-project"
  /** Opens the same dialog the tab bar's `+` opens: CLI, browser, notebook. */
  | "new-tab";

export interface WelcomeCall {
  action: WelcomeAction;
  /** Portuguese label — the key `t()` is called with where the button is drawn. */
  label: string;
}

/** Which button the welcome screen offers, given how many projects exist. */
export function welcomeCall(projectCount: number): WelcomeCall {
  return projectCount === 0
    ? { action: "new-project", label: "Adicionar projeto" } // i18n-ok — translated where drawn
    : { action: "new-tab", label: "Nova aba" }; // i18n-ok — translated where drawn
}
