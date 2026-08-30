/**
 * The building blocks of a Settings category.
 *
 * The whole screen is the same shape repeated: a group title, a card, and
 * inside it rows of "label on the left, control on the right" — the grammar
 * of system settings screens. It is written once here; each category only
 * declares its rows.
 *
 * Each row carries its own explanation (`desc`). In the old Preferences the
 * checkboxes were a stack of short phrases and the explanation came in a
 * paragraph down below, covering four of them at once — you could read it
 * all and still not know what each one did.
 */
import { type ReactNode } from "react";

import { NumberField } from "../NumberField";
import { Select, type SelectOption } from "../Select";
import { type ExtensionId } from "../../lib/extensions";
import { useExtensions } from "../../stores/extensionsStore";
import { clampPref, useUI, type Prefs } from "../../stores/uiStore";

/** Title of a group of rows — the small-caps label above the card. */
export function GroupTitle({ children }: { children: ReactNode }) {
  return <div className="set-group">{children}</div>;
}

/** The card that groups the rows: one border, one radius, hairlines between them. */
export function Card({ children }: { children: ReactNode }) {
  return <div className="set-card">{children}</div>;
}

/** One row of the card: label (with an optional description) and the control. */
export function Row({
  label,
  desc,
  children,
}: {
  label: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <span className="set-row-label">{label}</span>
        {desc && <small className="set-row-desc">{desc}</small>}
      </div>
      {children}
    </div>
  );
}

/** Boolean preferences — the only ones that become a switch. */
type BoolPref = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never;
}[keyof Prefs];

/** Switch row wired straight to a boolean preference. */
export function SwitchRow({
  pref,
  label,
  desc,
}: {
  pref: BoolPref;
  label: string;
  desc?: string;
}) {
  const on = useUI((s) => s.prefs[pref]);
  const setPref = useUI((s) => s.setPref);
  return (
    <ToggleRow label={label} desc={desc} checked={on} onChange={(v) => setPref(pref, v)} />
  );
}

/** The same design, for state kept outside `Prefs`. */
export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Row label={label} desc={desc}>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
    </Row>
  );
}

/**
 * Switch row for a feature that ships with the Yard and starts off.
 *
 * These are the switches the old store shelf held. They are kept apart from
 * the preferences (`kv ext.enabled`, not `Prefs`) because turning one on is
 * what drags its code in — the minimap, Prettier and the icon maps are lazy
 * chunks, and a profile that never asked for them never pays for them. On
 * screen there is no such distinction: it is a row like any other, on the page
 * of the surface it changes.
 */
export function FeatureRow({
  id,
  label,
  desc,
}: {
  id: ExtensionId;
  label: string;
  desc?: string;
}) {
  const on = useExtensions((s) => s.enabled[id] === true);
  const setEnabled = useExtensions((s) => s.setEnabled);
  return <ToggleRow label={label} desc={desc} checked={on} onChange={(v) => setEnabled(id, v)} />;
}

/** Row with a fixed-width pop-up button, the design's measure. */
export function PickerRow({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Row label={label}>
      <Select
        className="set-picker"
        label={label}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
      />
    </Row>
  );
}

/** Numeric preferences: the only ones with a range worth enforcing. */
type NumPref = Extract<
  keyof Prefs,
  | "fontSize"
  | "scrollback"
  | "codeFontSize"
  | "codeLineHeight"
  | "codeTabSize"
  | "autoBackupKeep"
  | "budgetDaily"
>;

/**
 * Numeric field of a preference. The `NumberField`'s own `<label>` is the
 * row — the label is tied to the field with no `htmlFor` at all.
 *
 * The text is local while typing and the range applies once, on leaving the
 * field: wiring the field straight to the store clamped **on every key** —
 * selecting "20000" and typing `5` became `5`, got pinned to the 1000 floor,
 * and the controlled field swallowed the rest of the number. It is also what
 * avoids one `write_pref` per keystroke. The rule lives in
 * `NumberField`/`lib/numericField.ts`.
 */
export function NumberRow({
  pref,
  label,
  min,
  max,
  step,
  wide,
}: {
  pref: NumPref;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Five-digit fields (the scrollback) need a bigger box. */
  wide?: boolean;
}) {
  const value = useUI((s) => s.prefs[pref]);
  const setPref = useUI((s) => s.setPref);
  return (
    <NumberField
      className={`set-row set-row--num ${wide ? "set-row--wide" : ""}`}
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      clamp={(n) => clampPref(pref, n)}
      onChange={(n) => setPref(pref, n)}
    />
  );
}

/** String preferences that are typed rather than picked from a list. */
type TextPref = {
  [K in keyof Prefs]: Prefs[K] extends string ? K : never;
}[keyof Prefs];

/**
 * A short free-text preference. The value is committed as it is typed: these
 * are all parsed defensively at the point of use, so a half-written "80, 1"
 * costs a redraw and never an error.
 */
export function TextRow({
  pref,
  label,
  desc,
  placeholder,
}: {
  pref: TextPref;
  label: string;
  desc?: string;
  placeholder?: string;
}) {
  const value = useUI((s) => s.prefs[pref]);
  const setPref = useUI((s) => s.setPref);
  return (
    <Row label={label} desc={desc}>
      <input
        className="set-text"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setPref(pref, e.target.value)}
      />
    </Row>
  );
}
