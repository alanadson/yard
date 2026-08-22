/**
 * Shortcut map.
 *
 * It exists because the whole app is keyboard-driven: without a list, the
 * shortcuts only live in button `title`s — and the ones that matter
 * (switch tab, switch group) have no button at all.
 *
 * The table itself lives in `lib/shortcuts.ts`: Settings shows a summary of
 * it, and two hand-written lists would diverge within a week.
 */
import { Modal } from "./Modal";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { useUI } from "../../stores/uiStore";

export function ShortcutsModal() {
  const closeModal = useUI((s) => s.closeModal);

  return (
    <Modal title="Atalhos de teclado" onClose={closeModal}>
      {SHORTCUT_GROUPS.map((g) => (
        <section className="shortcut-group" key={g.title}>
          <h4>{g.title}</h4>
          {g.items.map(([keys, description]) => (
            <div className="shortcut-row" key={description}>
              <span>{description}</span>
              <span className="shortcut-keys">
                {keys.map((t, i) => (
                  <span key={t}>
                    {i > 0 && "+"} <kbd>{t}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      <p className="hint">
        Fora essas, tudo que você digita vai direto para a CLI — o Yard não
        intercepta teclas que o terminal precisa.
      </p>
    </Modal>
  );
}
