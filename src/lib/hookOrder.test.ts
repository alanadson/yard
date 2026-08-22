/**
 * The defect these rules lock down cost a black screen and an app that would
 * not open anymore.
 *
 * `TerminalPane` passed `useAgents` a selector that read `active` — a `const`
 * declared 45 lines **below**. Zustand calls the selector during render, so
 * the read fell into the `const`'s temporal dead zone:
 * `ReferenceError: Cannot access 'active' before initialization`. With no
 * error boundary, React unmounted the whole tree: black window. And the pane
 * only mounted when the group had some tab, so the crash only showed up when
 * opening the first file — and then on **every** boot, because the tab was
 * persisted.
 *
 * `tsc` does not see this: the reference is inside an arrow, and an arrow
 * can, in theory, run later. The difference is who calls it: a store selector
 * and `useMemo` run **during** render; `useEffect` and `useCallback` only
 * store the function. Only the former fall into the dead zone.
 */
import { describe, expect, it } from "vitest";

import { hookOrderViolations, type HookOrderViolation } from "./hookOrder";

describe("hookOrderViolations", () => {
  it("flags the store selector that reads a const declared later", () => {
    const font = `
      function Painel() {
        const temSessao = useAgents((s) => (active ? s.byId[active.id] : null));
        const active = useMemo(() => terminals[0] ?? null, [terminals]);
        return temSessao;
      }
    `;
    expect(hookOrderViolations(font, "Painel.tsx")).toEqual([
      { file: "Painel.tsx", line: 3, hook: "useAgents", name: "active" },
    ]);
  });

  it("flags nothing when the const was already declared before", () => {
    const theFont = `
      function Painel() {
        const active = useMemo(() => terminals[0] ?? null, [terminals]);
        const temSessao = useAgents((s) => (active ? s.byId[active.id] : null));
        return temSessao;
      }
    `;
    expect(hookOrderViolations(theFont, "Painel.tsx")).toEqual([]);
  });

  it("the useMemo factory counts: it runs during render", () => {
    const font = `
      function Painel() {
        const rotulo = useMemo(() => nome.toUpperCase(), [nome]);
        const nome = "yard";
        return rotulo;
      }
    `;
    expect(hookOrderViolations(font, "Painel.tsx")).toEqual([
      { file: "Painel.tsx", line: 3, hook: "useMemo", name: "nome" },
    ]);
  });

  it("useEffect and useCallback only store the arrow — they may read what comes later", () => {
    const font = `
      function Painel() {
        useEffect(() => console.log(nome), [nome]);
        const enviar = useCallback(() => send(nome), [nome]);
        const nome = "yard";
        return enviar;
      }
    `;
    expect(hookOrderViolations(font, "Painel.tsx")).toEqual([]);
  });

  it("a property with the same name is not mistaken for the variable", () => {
    const font = `
      function Painel() {
        const aberto = useUI((s) => s.active);
        const active = 1;
        return aberto + active;
      }
    `;
    expect(hookOrderViolations(font, "Painel.tsx")).toEqual([]);
  });

  it("another component's const does not leak into this one", () => {
    const font = `
      function Primeiro() {
        return useUI((s) => s.byId[active]);
      }
      function Segundo() {
        const active = 1;
        return active;
      }
    `;
    expect(hookOrderViolations(font, "Painel.tsx")).toEqual([]);
  });
});

/**
 * The sweep is the test that actually catches the defect: no file in `src/`
 * may read, from inside a selector, a `const` that is only born later.
 *
 * Vite's `import.meta.glob` instead of `fs`: it is the same resolver the app
 * uses, and it does not require `@types/node` just to sweep a folder.
 */
const FONTS = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the whole src/", () => {
  it("has no render hook reading a const declared later", () => {
    const found: HookOrderViolation[] = [];
    for (const [path, font] of Object.entries(FONTS)) {
      if (/\.test\.tsx?$/.test(path)) continue;
      found.push(...hookOrderViolations(font, path.replace(/^\/src\//, "")));
    }
    // A sweep that looked at nothing would pass silently.
    expect(Object.keys(FONTS).length).toBeGreaterThan(100);
    expect(
      found.map((v) => `${v.file}:${v.line} ${v.hook}(...) lê '${v.name}'`),
    ).toEqual([]);
  });
});
