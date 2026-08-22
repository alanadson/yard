/**
 * The rule of a numeric field that does not fight whoever types in it.
 *
 * While typing, what holds is the **text** — including empty, which is a step
 * in the middle of editing and not a value. The number is only decided when
 * the field is left (blur, Enter). See `numericField.test.ts` for the defect
 * this prevents.
 */

/**
 * The number the field comes to hold on leaving it.
 *
 * @param raw what is written in the field, as the user typed it
 * @param current the value that already held — the answer when the text is not a number
 * @param clamp the field's floor, ceiling and rounding
 */
export function valueOnBlur(
  raw: string,
  current: number,
  clamp: (n: number) => number,
): number {
  const theText = raw.trim();
  if (theText === "") return current;
  const n = Number(theText);
  return Number.isFinite(n) ? clamp(n) : current;
}
