/**
 * Vitest inherits everything from `vite.config.ts`; only two things change
 * here.
 *
 * By default vitest returns an empty string for any CSS import, including
 * `styles.css?raw`. But that is how `TitleBar/styles.test.ts` checks that the
 * bar's classes (which mounts on boot) are in the CSS that loads on boot —
 * without this the test would pass by comparing against nothing. The carve-out
 * is as small as possible: **only** `?raw` imports, which only the tests make;
 * a component's `import "./x.css"` stays neutralized as before.
 *
 * And the English dictionary, which the app fetches lazily, is registered
 * before every file (`src/lib/i18nTestSetup.ts`), so a test still switches to
 * English with one synchronous `setActiveLang("en")`.
 */
import { defineConfig, mergeConfig, type UserConfigFnPromise } from "vitest/config";

import viteConfig from "./vite.config";

export default defineConfig(async (env) =>
  mergeConfig(await (viteConfig as UserConfigFnPromise)(env), {
    test: {
      css: { include: [/\.css\?raw$/] },
      setupFiles: ["src/lib/i18nTestSetup.ts"],
    },
  }),
);
