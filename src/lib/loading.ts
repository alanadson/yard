/**
 * The three states of an async read, in a single type.
 *
 * It exists because the fourth state — "failed, but the screen shows empty" —
 * was the most common one in the app and the only one nobody wanted. See
 * `loading.test.ts` for the screens that fell into it.
 *
 * The gain is the compiler: with `estado` as the discriminant, there is no way
 * to render the list without first deciding what to do with `falhou`.
 */

export type LoadState<T> =
  | { readonly state: "carregando" }
  | { readonly state: "pronto"; readonly data: T }
  | { readonly state: "falhou"; readonly reason: string };

/** The initial state of every read. */
export const LOADING = { state: "carregando" } as const;

/**
 * Readable text for whatever was thrown.
 *
 * `String(e)` on an `Error` returns `"Error: disco sumiu"`, and the `"Error: "`
 * in front of a sentence the user is going to read is noise. On an arbitrary
 * object it returns `"[object Object]"`, which is worse than saying nothing.
 */
export function reasonOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : "";
  return raw.trim() || "falha desconhecida";
}

/**
 * Awaits the promise and returns the matching state. A rejection **never**
 * becomes `pronto`: that is the one rule this module exists to guarantee.
 */
export async function load<T>(promise: Promise<T>): Promise<LoadState<T>> {
  try {
    return { state: "pronto", data: await promise };
  } catch (e) {
    return { state: "falhou", reason: reasonOf(e) };
  }
}

/**
 * "Can the screen say *nothing here yet*?" Only when the read succeeded and
 * nothing came back. Loading is not known yet; failed is a different sentence,
 * with the reason.
 */
export function isEmpty<T>(c: LoadState<readonly T[]>): boolean {
  return c.state === "pronto" && c.data.length === 0;
}
