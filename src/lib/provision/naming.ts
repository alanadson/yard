/**
 * Names for a batch of fronts.
 *
 * Three names travel together and are **not** derived from one another after
 * the fact: what the front is called on screen, what its branch is called,
 * and what folder it lands in. The dialog offers a default for the second and
 * third out of the first, and the moment someone edits one of them the other
 * two stay put — the alternative is the rename that silently moves a folder.
 *
 * This module only writes candidates. Whether a candidate is free is the
 * backend's answer for the repository (`worktree_preflight`) and this
 * module's answer for the batch: git is asked one row at a time and tells
 * every one of four identical rows that the name is free.
 */

/** Values a row's pattern may mention. `index` is 0-based; `{index}` is not. */
export interface PatternVars {
  name?: string;
  agent?: string;
  index: number;
}

/**
 * `exp-{agent}-{index}` → `exp-codex-1`. A placeholder nobody filled stays as
 * written: a visible `{nope}` is a bug report, `undefined` in a branch name
 * is a folder called undefined.
 */
export function expandPattern(pattern: string, vars: PatternVars): string {
  const table: Record<string, string> = {
    index: String(vars.index + 1),
    ...(vars.name !== undefined ? { name: vars.name } : {}),
    ...(vars.agent !== undefined ? { agent: vars.agent } : {}),
  };
  return pattern.replace(/\{(\w+)\}/g, (whole, key: string) => table[key] ?? whole);
}

/** The accents a Portuguese name actually carries, mapped instead of dropped. */
const FOLD: Record<string, string> = {
  á: "a", à: "a", â: "a", ã: "a", ä: "a",
  é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ò: "o", ô: "o", õ: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "c", ñ: "n",
};

/**
 * The branch a written name becomes — the same shape `git::floor_slug`
 * builds on the other side, plus the bar, which a branch is allowed to have
 * and a folder name is not.
 *
 * "Correção" folds to `correcao`, not `correo`: dropping the accented letter
 * makes two different names collapse into one, and the person reading the
 * plan cannot see why.
 */
export function branchSlug(name: string): string {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    const mapped = FOLD[c] ?? (/[a-z0-9/]/.test(c) ? c : "");
    if (mapped) {
      out += mapped;
    } else if (out && !out.endsWith("-") && !out.endsWith("/")) {
      out += "-";
    }
  }
  // git refuses a ref ending in `/`, in `.` or in `.lock`, and a trailing
  // hyphen is only ugly — all three are trimmed here rather than explained
  // in an error later.
  out = out.replace(/^[-/.]+/, "").replace(/[-/.]+$/, "");
  return out || "frente";
}

/**
 * `login` → `login-2` → `login-3`, walking past what the batch already spoke
 * for. Case-insensitive on purpose: two folders that differ only in case are
 * one folder on Windows, and the second `worktree add` is what finds out.
 */
export function uniqueIn(candidate: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((s) => s.toLowerCase()));
  if (!lower.has(candidate.toLowerCase())) return candidate;
  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}-${n}`;
    if (!lower.has(next.toLowerCase())) return next;
  }
  return `${candidate}-${Date.now()}`;
}
