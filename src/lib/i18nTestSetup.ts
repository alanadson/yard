/**
 * The suite's setup step (`vitest.config.ts`, `setupFiles`): the English
 * dictionary, handed to `lib/i18n` before every test file.
 *
 * The app fetches those lines lazily, the first time English is resolved
 * (`loadEnglish`). The tests were written when they were a plain import, and
 * switch with a synchronous `setActiveLang("en")` right before asserting the
 * English text; registering the dictionary up front keeps every one of them
 * meaning exactly what it meant, with no edit. The lazy path has tests of its
 * own (`i18n.lazy.test.ts`, `stores/langStore.lazy.test.ts`), which take a
 * fresh copy of the module (`vi.resetModules`) to see a boot that has not
 * fetched anything.
 *
 * Keep this file this small. A module a setup file loads is cached before the
 * test file's `vi.mock` calls take effect, so whatever it imports escapes
 * every test's mocks: here that is the dictionary (plain data) and
 * `lib/i18n`, whose one dependency is the log bridge it reports gaps through.
 */
import EN from "../i18n/en";
import { registerEnglish } from "./i18n";

registerEnglish(EN);
