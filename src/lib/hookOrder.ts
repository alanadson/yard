/**
 * Temporal dead zone inside a selector: the defect `tsc` does not see.
 *
 * A component that does
 *
 * ```tsx
 * const temSessao = useAgents((s) => (active ? s.byId[active.id] : null));
 * // …45 lines later…
 * const active = useMemo(() => terminals[0] ?? null, [terminals]);
 * ```
 *
 * breaks **during render**, with `Cannot access 'active' before
 * initialization`. Zustand calls the selector right away, and at that moment
 * the `const` is still in the dead zone. `tsc` lets it through because the
 * read lives inside an arrow, and an arrow can, in theory, run later — it has
 * no way of knowing who calls it.
 *
 * That is the difference: **who calls it and when**.
 *
 * - A store selector (`useAgents`, `useProjects`, …) and the `useMemo` factory
 *   run during render → the read falls into the dead zone.
 * - `useEffect`, `useCallback` and company only **store** the function → by
 *   the time it runs, the `const` has been born.
 *
 * That is why the rule looks at the hook's name, not at the arrow.
 */
import ts from "typescript";

export interface HookOrderViolation {
  file: string;
  /** 1-based, the way the editor counts. */
  line: number;
  /** The hook that received the arrow (`useAgents`). */
  hook: string;
  /** The `const` read too early (`active`). */
  name: string;
}

/**
 * Hooks that only file the function away to call after render. Reading a
 * `const` from below inside them is legitimate — by the time the function
 * runs, it already exists.
 *
 * A custom hook that also defers the call (takes a callback and stores it)
 * goes on this list; otherwise it becomes a false positive.
 */
const DEFERRED = new Set([
  "useCallback",
  "useEffect",
  "useEvent",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useRef",
]);

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node);

/** Names the arrow itself creates — parameters and declarations, at any depth. */
function boundNames(fn: ts.FunctionLikeDeclaration): Set<string> {
  const out = new Set<string>();
  const collectName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) out.add(name.text);
    else for (const el of name.elements) {
      if (!ts.isOmittedExpression(el)) collectName(el.name);
    }
  };
  const floor = (node: ts.Node) => {
    if (ts.isParameter(node)) collectName(node.name);
    else if (ts.isVariableDeclaration(node)) collectName(node.name);
    else if (ts.isFunctionDeclaration(node) && node.name) out.add(node.name.text);
    ts.forEachChild(node, floor);
  };
  for (const p of fn.parameters) collectName(p.name);
  if (fn.body) ts.forEachChild(fn.body, floor);
  return out;
}

/**
 * Flags every read, from inside an arrow that runs **during render**, of a
 * `const`/`let` declared further down in the same function body.
 */
export function hookOrderViolations(
  source: string,
  file: string,
): HookOrderViolation[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: HookOrderViolation[] = [];

  /** Where each top-level `const`/`let` of this body starts. */
  const declarations = (body: ts.Block) => {
    const pos = new Map<string, number>();
    const collectName = (name: ts.BindingName, start: number) => {
      if (ts.isIdentifier(name)) {
        if (!pos.has(name.text)) pos.set(name.text, start);
      } else {
        for (const el of name.elements) {
          if (!ts.isOmittedExpression(el)) collectName(el.name, start);
        }
      }
    };
    for (const st of body.statements) {
      if (!ts.isVariableStatement(st)) continue;
      const block = st.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let);
      if (!block) continue;
      for (const d of st.declarationList.declarations) collectName(d.name, st.getStart(sf));
    }
    return pos;
  };

  /** Inside a render arrow: who is read before being born. */
  const check = (
    arrow: ts.FunctionLikeDeclaration,
    hook: string,
    calledAt: number,
    declarationStarts: Map<string, number>,
  ) => {
    const ownNames = boundNames(arrow);
    // A selector tends to read the same name twice (`active?.id` and
    // `active.id`). The defect is one — flagging it twice is noise.
    const alreadyReported = new Set<string>();
    const theFloor = (node: ts.Node) => {
      // Types read nothing at runtime.
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node)) {
        const p = node.parent;
        const isField = ts.isPropertyAccessExpression(p) && p.name === node;
        const isKey = ts.isPropertyAssignment(p) && p.name === node;
        const declaredAt = declarationStarts.get(node.text);
        if (!isField && !isKey && !ownNames.has(node.text) && declaredAt !== undefined) {
          if (declaredAt > calledAt && !alreadyReported.has(node.text)) {
            alreadyReported.add(node.text);
            out.push({
              file,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              hook,
              name: node.text,
            });
          }
        }
      }
      ts.forEachChild(node, theFloor);
    };
    if (arrow.body) ts.forEachChild(arrow.body, theFloor);
  };

  /** A function body is a scope: its `const`s do not apply to its neighbours. */
  const scope = (fn: ts.FunctionLikeDeclaration) => {
    const body = fn.body;
    if (!body || !ts.isBlock(body)) return;
    const declarationStarts = declarations(body);
    if (declarationStarts.size === 0) return;
    const floor = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const hook = node.expression.text;
        if (/^use[A-Z]/.test(hook) && !DEFERRED.has(hook)) {
          const calledAt = node.getStart(sf);
          for (const arg of node.arguments) {
            if (isFunction(arg)) check(arg, hook, calledAt, declarationStarts);
          }
        }
      }
      // A nested function has its own scope — it is visited from outside.
      if (node !== fn && isFunction(node)) return;
      ts.forEachChild(node, floor);
    };
    floor(fn);
  };

  const walk = (node: ts.Node) => {
    if (isFunction(node)) scope(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return out;
}
