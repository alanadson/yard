/**
 * Settings — the full screen that replaced the Preferences dialog.
 *
 * The dialog stacked five sections on one 720px scrolling sheet: to reach
 * "Data" you went past font, editor, terminal and behavior, and what you were
 * looking for showed up in the middle of everything you were not. Shortcuts
 * and Extensions were not even there — they were two other dialogs, each with
 * its own door.
 *
 * Here there is a menu on the left and a 620px reading column on the right:
 * each category is a screen, each row carries its own explanation, and the
 * column ends where a line of text can still be read. The screen covers the
 * workspace but not the title bar — the window buttons and the drag area stay
 * alive, which is what the design puts in that 44px strip.
 *
 * The open category may arrive from outside (`openModal("preferences", "dados")`);
 * `categories.ts` sifts what comes in.
 */
import { useEffect, useRef, useState } from "react";
import {
  Blocks,
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

// `.switch`, `.ext-radio`, `.hint` and `.paths` were born in the dialogs' CSS
// and are the same pieces here; the screen imports that sheet instead of
// keeping a second copy of the four rules.
import "../modals/modal.css";
import "./settings.css";

import { useDialogFocus } from "../../hooks/useDialogFocus";
import { isTopLayer } from "../../lib/layers";
import { useUI } from "../../stores/uiStore";
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
import { SecExtensions } from "./sections/Extensions";
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
  extensoes: Blocks,
  mcp: Plug,
};

export function SettingsScreen() {
  const closeModal = useUI((s) => s.closeModal);
  const payload = useUI((s) => s.modalPayload);
  // Sifted once, on opening: switching categories afterwards is the screen's
  // business, not the opener's.
  const [cat, setCat] = useState<SettingsCategory>(() => isValidCategory(payload));
  const ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const fonts = useFonts();
  const t = useT();

  useDialogFocus(ref, true, "modal");

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

  // Switching categories is switching screens: starting midway through the
  // previous scroll hides the title of the one that just opened.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [cat]);

  const info = category(cat);

  return (
    <div
      className="settings"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("Configurações")}
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
                // In a narrow window the menu becomes icons only; the balloon
                // is what gives the name back (the CSS turns it off at the
                // width where the label is in view).
                data-tip={t(c.label)}
                data-tip-at="right"
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
            <div>
              <h2>{t(info.title)}</h2>
              <p>{t(info.desc)}</p>
            </div>
            <button
              className="icon-btn"
              onClick={closeModal}
              aria-label={t("Fechar")}
              data-tip={t("Fechar (Esc)")}
            >
              <X size={14} />
            </button>
          </header>

          {cat === "interface" && <SecInterface fontes={fonts} goTo={setCat} />}
          {cat === "terminal" && <SecTerminal fontes={fonts} />}
          {cat === "editor" && <SecEditor fontes={fonts} />}
          {cat === "agentes" && <SecAgents />}
          {cat === "comportamento" && <SecBehavior />}
          {cat === "atalhos" && <SecShortcuts />}
          {cat === "dados" && <SecData />}
          {cat === "extensoes" && <SecExtensions />}
          {cat === "mcp" && <SecMcp />}
        </div>
      </main>
    </div>
  );
}
