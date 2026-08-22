/**
 * Shortcuts — the summary of the keyboard map.
 *
 * The three groups that apply to the whole window, read from the same table
 * as the full list (`lib/shortcuts.ts`). The rest — editor, markdown, canvas
 * — is back-of-the-drawer material for whoever is already inside that
 * surface, and the screen points to `Ctrl+Shift+H` instead of repeating it all.
 */
import { SETTINGS_SHORTCUTS, groupsNamed } from "../../../lib/shortcuts";
import { Card, GroupTitle } from "../rows";

export function SecShortcuts() {
  return (
    <>
      {groupsNamed(SETTINGS_SHORTCUTS).map((g) => (
        <div key={g.title}>
          <GroupTitle>{g.title}</GroupTitle>
          <Card>
            {g.items.map(([keys, description]) => (
              <div className="set-key-row" key={description}>
                <span>{description}</span>
                <span className="set-keys">
                  {keys.map((t) => (
                    <kbd key={t}>{t}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </Card>
        </div>
      ))}
      <p className="hint">
        Fora essas, tudo que você digita vai direto para a CLI — o Yard não
        intercepta teclas que o terminal precisa. Os atalhos do editor, do
        markdown e do canvas aparecem na lista completa (Ctrl+Shift+H).
      </p>
    </>
  );
}
