/**
 * The "Extra arguments" field of "New terminal".
 *
 * The field is free text and stays free text: it is a command line, and
 * whoever knows the flag types it. What used to sit beside it — a button
 * opening a cheat sheet of every flag each CLI accepts — is gone. It offered
 * a dozen suggestions to sell one: the flag that stops the agent asking
 * permission before each edit.
 *
 * That one is a switch now, above the field, and only for the agents that
 * have such a flag. It is the System Settings row: what it does on the left,
 * the control on the right, the whole row a target. It writes into this same
 * field instead of keeping a state of its own, so what goes to the CLI is
 * always what is on screen — flip it and the flag appears in the text, erase
 * it by hand and the switch goes back off.
 */
import { useId } from "react";

import { hasFlag, withFlag, type SkipFlag } from "../../lib/termArgs";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** The chosen CLI's "skip the prompts" flag, when it has one. */
  skip: SkipFlag | null;
}

export function ArgsField({ value, onChange, skip }: Props) {
  const id = useId();

  return (
    <div className="args-field">
      {skip && (
        <label className="skip-row">
          <span className="skip-row-text">
            <strong>Sem pedir permissão</strong>
            {/* The flag itself leads the second line: the row has to say
                exactly what it will write into the field below. */}
            <small>
              <code>{skip.args.join(" ")}</code> · {skip.hint}
            </small>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={hasFlag(value, skip.args)}
            onChange={(e) => onChange(withFlag(value, skip.args, e.target.checked))}
          />
        </label>
      )}
      <label htmlFor={id}>
        Argumentos extras
        <input
          id={id}
          value={value}
          placeholder="opcional — vão direto para a linha de comando"
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
