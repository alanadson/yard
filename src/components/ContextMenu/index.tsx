/**
 * Floating menu (right-click or kebab).
 *
 * Renders in a portal on `body`: the sidebar has overflow and an inner
 * `position: absolute` would be clipped. Position is the click; if it does
 * not fit in the window, it flips to the other side before paint.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Minus, Plus, RotateCcw } from "lucide-react";

import { useT } from "../../hooks/useT";
import { useOccluders } from "../../stores/occludersStore";

export type MenuItem = {
  kind?: "item";
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /**
   * The entry is the state the thing is currently in — a tick in the icon
   * slot. Rows that are choices in a set (the portal's user agent, its cookie
   * scope) were indistinguishable from rows that are actions: the menu offered
   * three options and told the user nothing about which one was in effect.
   */
  checked?: boolean;
  /** Flyout to the right, as in the "Adicionar >" entry. */
  submenu?: MenuEntry[];
  onSelect?: () => void;
};

/**
 * Color-swatch row. Picking applies immediately and does **not** close the
 * menu: customizing color is trial-and-error; closing on every click would
 * force reopening the menu for each tone tried.
 */
export type MenuSwatches = {
  kind: "swatches";
  /**
   * Caption above the chips. Only worth setting when the menu carries more
   * than one row: two unlabelled rows of identical circles say nothing about
   * which one paints what.
   */
  label?: string;
  colors: readonly string[];
  active?: string;
  onPick: (color: string) => void;
  /**
   * When present, a leading "no color" chip. It is the only way back to the
   * default once a color has been picked — an optional property with no such
   * chip is a one-way door.
   */
  onClear?: () => void;
};

/** Size row (stroke thickness, body text…). Does not close the menu. */
export type MenuSizes = {
  kind: "sizes";
  options: readonly { id: string; dot: number; label: string }[];
  active?: string;
  onPick: (id: string) => void;
};

/**
 * A `−  value  +` row. Like the swatches, it keeps the menu open: finding the
 * right font size is pure trial and error, and reopening the menu for every
 * step would make the feature not worth using.
 */
export type MenuStepper = {
  kind: "stepper";
  label: string;
  value: string;
  /** Rendered greyed out when the value is inherited rather than set here. */
  muted?: boolean;
  /** Where the greyed-out value comes from. Defaults to the preferences. */
  mutedTip?: string;
  onStep: (delta: -1 | 1) => void;
  /** Shown as a "reset" affordance when there is something to reset. */
  onReset?: () => void;
  /** What "reset" means here. The default is the terminal card's: the prefs. */
  resetTip?: string;
};

export type MenuEntry =
  | MenuItem
  | { kind: "sep" }
  | MenuSwatches
  | MenuSizes
  | MenuStepper;

export interface MenuAnchor {
  x: number;
  y: number;
}

interface Props {
  anchor: MenuAnchor;
  items: MenuEntry[];
  onClose: () => void;
}

function isItem(entry: MenuEntry): entry is MenuItem {
  return entry.kind === undefined || entry.kind === "item";
}

export function ContextMenu({ anchor, items, onClose }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  /**
   * Callers write `onClose={() => setMenu(null)}` — a new function on every
   * parent render. Depending on it directly would tear the dismissal listeners
   * down and re-arm them (through a `setTimeout(0)`) on every unrelated
   * re-render of the canvas, leaving a frame-wide hole where a click outside
   * hits nothing and the menu stays up.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const close = useCallback(() => closeRef.current(), []);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const enabled = items.filter(isItem).filter((i) => !i.disabled);
  const [activeId, setActiveId] = useState<string | null>(enabled[0]?.id ?? null);

  /**
   * A portal's page is an OS window over the DOM: it would swallow this menu
   * whole. Publishing where the menu landed lets exactly the portals under it
   * step aside — the ones elsewhere on the board keep showing their site.
   */
  const occluderKey = useId();
  const setOccluder = useOccluders((s) => s.setOccluder);
  useEffect(() => () => setOccluder(occluderKey, null), [occluderKey, setOccluder]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    let left = anchor.x;
    let top = anchor.y;
    if (left + width > window.innerWidth - pad) left = window.innerWidth - width - pad;
    if (top + height > window.innerHeight - pad) top = window.innerHeight - height - pad;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    setPos({ left, top });
    setOccluder(occluderKey, { x: left, y: top, w: width, h: height });
    // `items` changes identity on every parent render (RAM HUD, etc.);
    // size only changes if the number of entries changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, items.length, occluderKey, setOccluder]);

  useEffect(() => {
    /**
     * Outside-click dismissal listens to **pointerdown**, not `mousedown`.
     *
     * The canvas cancels its own pointerdown to start a pan (and the note body
     * does the same to protect focus), and a canceled pointerdown suppresses
     * the compatibility `mousedown` that never arrives here. That is why the
     * menu used to stay stuck on screen after clicking somewhere unrelated.
     * Pointer events are the source of truth; capture phase so nothing on the
     * way can stop them either.
     */
    const outside = (t: EventTarget | null) => {
      if (t instanceof Node && ref.current?.contains(t)) return false;
      // A flyout is another `.menu` portaled to body — not a child of this
      // ref. Closing here would kill the submenu on the way to the click.
      if (t instanceof Element && t.closest(".menu")) return false;
      return true;
    };
    const onDown = (e: Event) => {
      if (outside(e.target)) close();
    };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && (t.closest(".xterm") || t.closest(".menu"))) {
        return;
      }
      close();
    };
    // Panning or zooming the canvas under an open menu leaves it pointing at
    // nothing — the anchor is a screen position, and the thing it referred to
    // has moved. Same reasoning as `resize`.
    const onWheel = (e: WheelEvent) => {
      if (outside(e.target)) close();
    };
    // Focus leaving the window means the click landed on a native surface
    // (the portal's browser), which produces no DOM event at all here.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    // On the next tick: the click/focus that opened the menu (and xterm's
    // internal scroll on focus) must not close it in the same interaction.
    const tid = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("contextmenu", onDown, true);
      window.addEventListener("wheel", onWheel, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", close);
      window.addEventListener("blur", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("contextmenu", onDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const idx = enabled.findIndex((i) => i.id === activeId);
    const next = enabled[(idx + dir + enabled.length) % enabled.length];
    setActiveId(next.id);
  };

  const [openSub, setOpenSub] = useState<string | null>(null);

  const activate = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu?.length) {
      setOpenSub(item.id);
      return;
    }
    if (!item.onSelect) return;
    onClose();
    // The menu unmounts on this tick; the action (dialog, focus, rename) on
    // the next one does not fight blur with the unmount.
    queueMicrotask(item.onSelect);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (enabled[0]) setActiveId(enabled[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = enabled[enabled.length - 1];
      if (last) setActiveId(last.id);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = enabled.find((i) => i.id === activeId);
      if (item) activate(item);
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="menu menu--popup"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry, i) => {
        if (entry.kind === "sep") {
          return <div key={`sep-${i}`} className="menu-sep" role="separator" />;
        }
        if (entry.kind === "swatches") {
          return (
            <div
              key={`sw-${i}`}
              className="menu-swatches"
              role="group"
              aria-label={entry.label ?? "Cor"}
            >
              {entry.label && <span className="menu-swatches-label">{entry.label}</span>}
              <div className="menu-swatches-row">
                {entry.onClear && (
                  <button
                    type="button"
                    className={`cv-swatch cv-swatch--none ${
                      entry.active ? "" : "is-active"
                    }`}
                    data-tip="Sem cor"
                    aria-label="Sem cor"
                    aria-pressed={!entry.active}
                    onClick={() => entry.onClear?.()}
                  />
                )}
                {entry.colors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`cv-swatch ${entry.active === c ? "is-active" : ""}`}
                    style={{ background: c }}
                    data-tip={c}
                    aria-label={`Cor ${c}`}
                    aria-pressed={entry.active === c}
                    onClick={() => entry.onPick(c)}
                  />
                ))}
              </div>
            </div>
          );
        }
        if (entry.kind === "stepper") {
          return (
            <div
              key={`st-${i}`}
              className="menu-stepper"
              role="group"
              aria-label={entry.label}
            >
              <span className="menu-label">{entry.label}</span>
              <button
                type="button"
                data-tip={t("Diminuir {what}", { what: entry.label.toLowerCase() })}
                aria-label={t("Diminuir {what}", { what: entry.label.toLowerCase() })}
                onClick={() => entry.onStep(-1)}
              >
                <Minus size={12} />
              </button>
              <span
                className={`menu-stepper-value ${entry.muted ? "is-muted" : ""}`}
                data-tip={entry.muted ? entry.mutedTip ?? t("Herdado das preferências") : undefined}
              >
                {entry.value}
              </span>
              <button
                type="button"
                data-tip={t("Aumentar {what}", { what: entry.label.toLowerCase() })}
                aria-label={t("Aumentar {what}", { what: entry.label.toLowerCase() })}
                onClick={() => entry.onStep(1)}
              >
                <Plus size={12} />
              </button>
              <button
                type="button"
                className="menu-stepper-reset"
                data-tip={entry.resetTip ?? t("Voltar ao tamanho das preferências")}
                aria-label={entry.resetTip ?? t("Voltar ao tamanho das preferências")}
                disabled={!entry.onReset}
                onClick={() => entry.onReset?.()}
              >
                <RotateCcw size={11} />
              </button>
            </div>
          );
        }
        if (entry.kind === "sizes") {
          return (
            <div key={`sz-${i}`} className="menu-sizes" role="group" aria-label="Tamanho">
              {entry.options.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={entry.active === s.id ? "is-active" : ""}
                  data-tip={s.label}
                  aria-label={s.label}
                  aria-pressed={entry.active === s.id}
                  onClick={() => entry.onPick(s.id)}
                >
                  <span className="cv-size-dot" style={{ width: s.dot, height: s.dot }} />
                </button>
              ))}
            </div>
          );
        }
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={[
              entry.danger ? "menu-danger" : "",
              entry.id === activeId ? "is-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onMouseEnter={() => {
              if (!entry.disabled) setActiveId(entry.id);
              setOpenSub(entry.submenu?.length ? entry.id : null);
            }}
            onClick={() => activate(entry)}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
          >
            <span className="menu-icon">
              {entry.checked ? <Check size={12} /> : entry.icon}
            </span>
            <span className="menu-label">{entry.label}</span>
            {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
            {entry.submenu && (
              <span className="menu-chevron" aria-hidden>
                <ChevronRight size={12} />
              </span>
            )}
          </button>
        );
      })}
      {openSub &&
        (() => {
          const host = items.filter(isItem).find((i) => i.id === openSub);
          if (!host?.submenu?.length) return null;
          const parent = ref.current?.getBoundingClientRect();
          const left = parent ? parent.right + 4 : pos.left + 196;
          const top = parent ? parent.top : pos.top;
          return (
            <ContextMenu
              anchor={{ x: left, y: top }}
              items={host.submenu}
              onClose={onClose}
            />
          );
        })()}
    </div>,
    document.body,
  );
}
