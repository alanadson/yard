/**
 * Modal frame.
 *
 * Beyond the look, it handles what separates a dialog from a floating div:
 * initial focus inside it, Tab trapped there (Tab on the last element goes
 * back to the first) and returning focus to whoever opened it on close.
 * Without that the keyboard wanders the tree behind the backdrop.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import "./modal.css";

import { useT } from "../../hooks/useT";
import { isTopLayer } from "../../lib/layers";
import { exitGesture, focusAfterTab } from "./modalGestures";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Lives in the header, between the title and the close button — a Mac
      toolbar slot for a search field or a small control. */
  headerExtra?: ReactNode;
  /** Fixed strip under the header (scope bar, tabs): filters belong outside
      the scroll, or the first scroll hides the controls that shape the list. */
  toolbar?: ReactNode;
  wide?: boolean;
  /**
   * CSS selector of what should hold focus when the dialog opens. Without it
   * the first focusable in the body wins, which is right for a form and wrong
   * for a dialog that opens on a toolbar — "new terminal" starts with a
   * "detect again" button that nobody came here to press.
   */
  initialFocus?: string;
  /**
   * The form has something typed in it. The first attempt to leave — **any**
   * of the three: backdrop, `Esc`, or the header's × — then flashes the dialog
   * and says so instead of discarding the work; the second one (within three
   * seconds) discards.
   *
   * "Criar andar" is what made this necessary: a name, a branch and three
   * blocks of hooks, all thrown away by one click that landed a few pixels
   * outside. The `Esc` came next, being the most reflexive gesture there is.
   * The × was the one left out, a few pixels from both — the rule now lives in
   * `exitGesture` and every exit goes through it.
   */
  dirty?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  title,
  onClose,
  children,
  footer,
  headerExtra,
  toolbar,
  wide,
  initialFocus,
  dirty,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  /** Set for the length of the "no, you have something typed" flash. */
  const [nudge, setNudge] = useState(false);
  /** Shows "Esc de novo descarta" while the warning is up. */
  const [notice, setNotice] = useState(false);
  /** One Esc has already warned — the next, within the window, really closes. */
  const escWarned = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const blink = () => {
    setNudge(false);
    // Two frames so the class really leaves the DOM before it comes back;
    // otherwise a second click inside the animation does nothing visible.
    requestAnimationFrame(() => requestAnimationFrame(() => setNudge(true)));
  };

  /**
   * The exit, whatever the gesture. The header's × did not go through here —
   * it closed outright — and took with it the whole form that the backdrop
   * and Esc protected, while sitting a few pixels from both.
   */
  const exit = () => {
    if (exitGesture({ dirty: !!dirty, warned: escWarned.current }) === "close") {
      onClose();
      return;
    }
    escWarned.current = true;
    setNotice(true);
    blink();
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      escWarned.current = false;
      setNotice(false);
    }, 3000);
  };

  const onBackdrop = (e: React.MouseEvent) => {
    // Only the primary button closes: with the right one the gesture is "open
    // the menu", and closing the dialog from under it would be the wrong answer.
    if (e.button !== 0) return;
    exit();
  };

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // First field in the body, otherwise the dialog itself: opening on a
    // close "x" would make Enter close the newly opened modal.
    const body = ref.current?.querySelector(".modal-body");
    // An explicit `initialFocus` may point anywhere in the dialog (the
    // extensions search lives in the header); only the *fallback* stays
    // scoped to the body, away from the close "x".
    const target =
      (initialFocus ? ref.current?.querySelector<HTMLElement>(initialFocus) : null) ??
      body?.querySelector<HTMLElement>(FOCUSABLE) ??
      ref.current;
    target?.focus();
    return () => previous?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The editor and the diff also listen for `Escape` on the window;
        // without the layer check, a modal opened above them closed both at
        // once.
        if (!isTopLayer("modal")) return;
        e.preventDefault();
        // With the form filled in, the first Esc warns instead of discarding
        // — the same rule as the other two gestures, now written in a single
        // place (`exitGesture`).
        exit();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null,
      );
      // `null` = the browser already moves correctly on its own. A returned
      // target covers the case that was missing: focus on the `body` (after
      // clicking some text in the dialog), from where Tab left for the title
      // bar behind the backdrop.
      const target = focusAfterTab(items, document.activeElement as HTMLElement, e.shiftKey);
      if (!target) return;
      e.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dirty]);

  return (
    <div className="modal-backdrop" onMouseDown={onBackdrop}>
      <div
        ref={ref}
        className={`modal ${wide ? "modal--wide" : ""} ${nudge ? "modal--nudge" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onAnimationEnd={() => setNudge(false)}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          {headerExtra && <div className="modal-header-extra">{headerExtra}</div>}
          <button
            className="icon-btn"
            onClick={exit}
            aria-label={t("Fechar")}
            data-tip={t("Fechar (Esc)")}
          >
            <X size={14} />
          </button>
        </div>
        {toolbar && <div className="modal-toolbar">{toolbar}</div>}
        <div className="modal-body">{children}</div>
        {notice && (
          <div className="modal-esc-hint" role="status">
            {t("Você tem algo preenchido aqui — fechar de novo (")}
            <kbd>Esc</kbd>
            {t(", o × ou um clique fora) descarta.")}
          </div>
        )}
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
