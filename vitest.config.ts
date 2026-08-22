/**
 * Vitest inherits everything from `vite.config.ts` — only one thing changes
 * here.
 *
 * By default vitest returns an empty string for any CSS import, including
 * `styles.css?raw`. But that is how `TitleBar/styles.test.ts` checks that the
 * bar's classes (which mounts on boot) are in the CSS that loads on boot —
 * without this the test would pass by comparing against nothing. The carve-out
 * is as small as possible: **only** `?raw` imports, which only the tests make;
 * a component's `import "./x.css"` stays neutralized as before.
 */
import { defineConfig, mergeConfig, type UserConfigFnPromise } from "vitest/config";

import viteConfig from "./vite.config";

export default defineConfig(async (env) =>
  mergeConfig(await (viteConfig as UserConfigFnPromise)(env), {
    test: { css: { include: [/\.css\?raw$/] } },
  }),
);
