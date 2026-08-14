/**
 * Modal frame.
 *
 * Beyond the look, it handles what separates a dialog from a floating div:
 * initial focus inside it, Tab trapped there (Tab on the last element goes
 * back to the first) and returning focus to whoever opened it on close.
 * Without that the keyboard wanders the tree behind the backdrop.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

const FOCAVEIS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, footer, wide }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    // First field in the body, otherwise the dialog itself: opening on a
    // close "x" would make Enter close the newly opened modal.
    const corpo = ref.current?.querySelector(".modal-body");
    const alvo = corpo?.querySelector<HTMLElement>(FOCAVEIS) ?? ref.current;
    alvo?.focus();
    return () => anterior?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const itens = [...ref.current.querySelectorAll<HTMLElement>(FOCAVEIS)].filter(
        (el) => el.offsetParent !== null,
      );
      if (itens.length === 0) return;
      const primeiro = itens[0];
      const ultimo = itens[itens.length - 1];
      const atual = document.activeElement;
      if (e.shiftKey && (atual === primeiro || atual === ref.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && atual === ultimo) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        className={`modal ${wide ? "modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Fechar"
            data-tip="Fechar (Esc)"
          >
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
