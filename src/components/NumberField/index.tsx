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
import { useEffect, useId, useState } from "react";

import { validateNumericDraft } from "../../lib/numericField";
import { useT } from "../../hooks/useT";

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Floor, ceiling and rounding — the same function the rest of the app uses. */
  clamp: (n: number) => number;
  onChange: (n: number) => void;
  onDraftChange?: (text: string) => void;
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
  onDraftChange,
  className,
}: Props) {
  const t = useT();
  const errorId = useId();
  const [theText, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);

  // Follows whoever changed the value from outside. Never fires mid-typing,
  // because typing does not write to the owner of the value.
  useEffect(() => setText(String(value)), [value]);

  const commitValue = () => {
    const result = validateNumericDraft(theText, clamp);
    if (!result.valid) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(result.value);
    setText(String(result.value));
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
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          onDraftChange?.(e.target.value);
          setInvalid(!validateNumericDraft(e.target.value, clamp).valid);
        }}
        onBlur={commitValue}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitValue();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setText(String(value));
            onDraftChange?.(String(value));
            setInvalid(false);
          }
        }}
      />
      {invalid && (
        <span className="hint hint--error number-field-error" id={errorId} role="alert">
          {t("Digite um número entre {min} e {max}.", { min, max })}
        </span>
      )}
    </label>
  );
}
