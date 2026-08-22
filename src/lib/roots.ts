/** Stable identity for a Windows project/worktree root. */
export function rootKey(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

export function sameRoot(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && rootKey(a) === rootKey(b);
}

/** A relative path is only unique together with the project/worktree root. */
export function rootedPathKey(root: string, path: string): string {
  return `${rootKey(root)}\u0000${path.replaceAll("\\", "/")}`;
}
