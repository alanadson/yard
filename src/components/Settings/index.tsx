/**
 * Settings — the window that replaced the Preferences dialog.
 *
 * The dialog stacked five sections on one 720px scrolling sheet: to reach
 * "Data" you went past font, editor, terminal and behavior, and what you were
 * looking for showed up in the middle of everything you were not. Shortcuts
 * was not even there — another dialog, with its own door. And the features
 * that ship turned off had a store shelf of their own; they are rows now, on
 * the page of the surface each one changes.
 *
 * Here there is a menu on the left and a 620px reading column on the right:
 * each category is a page, each row carries its own explanation, and the
 * column ends where a line of text can still be read. The whole thing is a
 * sheet in the middle of the window, over the same dimmed backdrop as every
 * other dialog. It was a full screen for a while — but a screen is a place
 * you go to, and a setting is something you open, flip and leave; the sheet
 * keeps the workspace in sight and closes with one click outside, like the
 * dialogs around it.
 *
 * The open category may arrive from outside (`openModal("preferences", "dados")`);
 * `categories.ts` sifts what comes in.
 */
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Code,
  Database,
  Keyboard,
  Monitor,
  Plug,
  Settings2,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";

// `.modal-backdrop`, `.switch`, `.hint` and `.paths` were born
// in the dialogs' CSS and are the same pieces here; the window imports that
// sheet instead of keeping a second copy of the five rules.
import "../modals/modal.css";
import "./settings.css";

import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isTopLayer } from "../../lib/layers";
import { useUI } from "../../stores/uiStore";
import { backdropPressExits } from "../modals/modalGestures";
import {
  category,
  isValidCategory,
  SETTINGS_CATEGORIES,
  type SettingsCategory,
} from "./categories";
import { useT } from "../../hooks/useT";
import { useFonts } from "./useFonts";
import { SecAgents } from "./sections/Agents";
import { SecBehavior } from "./sections/Behavior";
import { SecData } from "./sections/Data";
import { SecEditor } from "./sections/Editor";
import { SecInterface } from "./sections/Interface";
import { SecShortcuts } from "./sections/Shortcuts";
import { SecTerminal } from "./sections/Terminal";
import { SecMcp } from "./sections/Mcp";

const ICONS: Record<SettingsCategory, LucideIcon> = {
  interface: Monitor,
  terminal: Terminal,
  editor: Code,
  agentes: Bot,
  comportamento: Settings2,
  atalhos: Keyboard,
  dados: Database,
  mcp: Plug,
};

export function SettingsScreen() {
  const closeModal = useUI((s) => s.closeModal);
  const payload = useUI((s) => s.modalPayload);
  // Sifted once, on opening: switching categories afterwards is the window's
  // business, not the opener's.
  const [cat, setCat] = useState<SettingsCategory>(() => isValidCategory(payload));
  const ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const fonts = useFonts();
  const t = useT();

  useDialogFocus(ref, true, "modal");

  // Focus opens on the menu row that is already selected. Opened from the
  // keyboard (Ctrl+Shift+P) the ring shows where Tab will go from; opened by
  // a click the browser draws no ring, so nothing lights up that was not
  // asked for. Without this, focus stayed on the opener behind the backdrop.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".set-nav-item.is-active")?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The editor and the diff also listen for `Escape` on the window; without
      // the layer check, one Esc here would close both at once.
      if (e.key !== "Escape" || !isTopLayer("modal")) return;
      e.preventDefault();
      closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  // Switching categories is switching pages: starting midway through the
  // previous scroll hides the title of the one that just opened.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [cat]);

  /**
   * Leaving by a press outside the sheet. Two of the agent fields (tab name,
   * command line) save on blur, and the backdrop closes on `mousedown` —
   * before focus ever leaves the field, so before it saves. Blurring first is
   * what keeps the typed text. The × needs no such care: a button takes focus
   * on the way to its click, and that blur saves.
   */
  const onBackdrop = (e: React.MouseEvent) => {
    if (!backdropPressExits(e.button)) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    closeModal();
  };

  const info = category(cat);

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div
        className="settings"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t("Configurações")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="set-nav" aria-label={t("Categorias")}>
          <h1 className="set-nav-title">{t("Configurações")}</h1>
          <div className="set-nav-list">
            {SETTINGS_CATEGORIES.map((c) => {
              const Icon = ICONS[c.id];
              return (
                <button
                  key={c.id}
                  className={`set-nav-item ${c.id === cat ? "is-active" : ""}`}
                  aria-current={c.id === cat ? "page" : undefined}
                  // In a narrow sheet the menu becomes icons only; the balloon
                  // is what gives the name back (the CSS turns it off at the
                  // width where the label is in view). It exits to the right,
                  // at button height: anchored to the button's right edge it
                  // grew leftwards, past the sheet, and "Dados e backup" read
                  // "backup".
                  data-tip={t(c.label)}
                  data-tip-side="right"
                  onClick={() => setCat(c.id)}
                >
                  <span className="set-nav-icon" style={{ background: c.tone }}>
                    <Icon size={12} />
                  </span>
                  {t(c.label)}
                </button>
              );
            })}
          </div>
          <div className="set-nav-foot">{t("Yard · dados em %APPDATA%\\Yard")}</div>
        </nav>

        <main className="set-main" ref={mainRef}>
          <div className="set-col">
            <header className="set-head">
              <h2>{t(info.title)}</h2>
              <p>{t(info.desc)}</p>
            </header>

            {cat === "interface" && <SecInterface fontes={fonts} />}
            {cat === "terminal" && <SecTerminal fontes={fonts} />}
            {cat === "editor" && <SecEditor fontes={fonts} />}
            {cat === "agentes" && <SecAgents />}
            {cat === "comportamento" && <SecBehavior />}
            {cat === "atalhos" && <SecShortcuts />}
            {cat === "dados" && <SecData />}
            {cat === "mcp" && <SecMcp />}
          </div>
        </main>

        {/* Last in the DOM so Tab visits menu and page before the way out;
            the CSS pins it to the sheet's top-right corner, where every
            other dialog keeps its ×. */}
        <button
          className="icon-btn set-close"
          onClick={closeModal}
          aria-label={t("Fechar")}
          data-tip={t("Fechar (Esc)")}
          data-tip-at="right"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
