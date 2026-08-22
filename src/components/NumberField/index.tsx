/**
 * Labelled numeric field.
 *
 * One lived inside Preferences, written carefully; Routines had another,
 * written the naive way (`Number(e.target.value) || 1`), which would not let
 * you clear the content to type a different number. Two patterns for the same
 * control in the same app is the kind of inconsistency that makes the user
 * think the screen is broken — so now there is only one.
 *
 * The rule it embodies lives in `lib/numericField.ts`, with a test.
 */
import { useEffect, useState } from "react";

import { valueOnBlur } from "../../lib/numericField";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Floor, ceiling and rounding — the same function the rest of the app uses. */
  clamp: (n: number) => number;
  onChange: (n: number) => void;
  /** Hides the visible label, for callers that already have a `<label>` around it. */
  className?: string;
}

export function NumberField({
  label,
  value,
  min,
  max,
  step,
  clamp: clamp,
  onChange,
  className,
}: Props) {
  const [theText, setText] = useState(String(value));

  // Follows whoever changed the value from outside. Never fires mid-typing,
  // because typing does not write to the owner of the value.
  useEffect(() => setText(String(value)), [value]);

  const commitValue = () => {
    const target = valueOnBlur(theText, value, clamp);
    onChange(target);
    // Not `String(value)`: when the clamp returns the value that was already
    // in force, the owner does not change, and the field would keep showing
    // the rejected text.
    setText(String(target));
  };

  return (
    <label className={className}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={theText}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitValue}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitValue();
          } else if (e.key === "Escape") {
            setText(String(value));
          }
        }}
      />
    </label>
  );
}
