/**
 * Shortcuts — the summary of the keyboard map, and the one key that is the
 * user's to choose.
 *
 * The three groups that apply to the whole window, read from the same table
 * as the full list (`lib/shortcuts.ts`). The rest — editor, markdown, canvas
 * — is back-of-the-drawer material for whoever is already inside that
 * surface, and the screen points to `Ctrl+Shift+H` instead of repeating it all.
 * The table keeps its Portuguese; titles and descriptions are translated
 * here, where they are drawn.
 *
 * Above them, the summon hotkey: the only shortcut that works with the
 * window hidden or behind something else, and therefore the only one that
 * can collide with other applications — which is why it is editable.
 */
import { useEffect, useId, useState } from "react";

import { useT } from "../../../hooks/useT";
import { SETTINGS_SHORTCUTS, groupsNamed } from "../../../lib/shortcuts";
import { normalizeHotkey } from "../../../lib/tray";
import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle } from "../rows";

function SummonHotkeyRow() {
  const t = useT();
  const stored = useUI((s) => s.prefs.summonHotkey);
  const setPref = useUI((s) => s.setPref);
  const [text, setText] = useState(stored);
  const id = useId();
  useEffect(() => setText(stored), [stored]);

  const trimmed = text.trim();
  const accelerator = trimmed ? normalizeHotkey(trimmed) : null;
  const invalid = trimmed.length > 0 && accelerator === null;

  // Only what is valid (or empty = off) reaches the preference; a typo stays
  // in the field with the error under it, and the last good hotkey keeps
  // working meanwhile.
  const commit = () => {
    if (invalid) return;
    if (trimmed !== stored) setPref("summonHotkey", trimmed);
  };

  return (
    <>
      <label className="set-row set-agent-args" htmlFor={id}>
        <span className="set-row-text">
          <span className="set-row-label">{t("Atalho global para trazer o Yard")}</span>
          <small className="set-row-desc">
            {t(
              "Funciona de qualquer aplicativo: traz a janela (ou a esconde, se já está na frente). Vazio desliga.",
            )}
          </small>
        </span>
        <input
          id={id}
          value={text}
          spellCheck={false}
          placeholder={t("ex.: Ctrl+Alt+Y")}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${id}-err` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setText(stored);
          }}
        />
      </label>
      {invalid && (
        <p className="hint hint--error" role="alert" id={`${id}-err`}>
          {t(
            "Um atalho global precisa de pelo menos um modificador (Ctrl, Alt, Shift ou Win) e uma tecla — por exemplo",
          )}{" "}
          <code>Ctrl+Alt+Y</code> {t("ou")} <code>Ctrl+Shift+F12</code>.
        </p>
      )}
    </>
  );
}

export function SecShortcuts() {
  const t = useT();
  return (
    <>
      <GroupTitle>{t("Fora da janela")}</GroupTitle>
      <Card>
        <SummonHotkeyRow />
      </Card>
      {groupsNamed(SETTINGS_SHORTCUTS).map((g) => (
        <div key={g.title}>
          <GroupTitle>{t(g.title)}</GroupTitle>
          <Card>
            {g.items.map(([keys, description]) => (
              <div className="set-key-row" key={description}>
                <span>{t(description)}</span>
                <span className="set-keys">
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </Card>
        </div>
      ))}
      <p className="hint">
        {t(
          "Fora essas, tudo que você digita vai direto para a CLI — o Yard não intercepta teclas que o terminal precisa. Os atalhos do editor, do markdown e do canvas aparecem na lista completa (Ctrl+Shift+H).",
        )}
      </p>
    </>
  );
}
