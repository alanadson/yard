/**
 * Pop-up button — the app's replacement for the native `<select>`.
 *
 * The swap is not cosmetic. On Windows the WebView draws the `<select>` list
 * in a window of its own and paints that window with the control's computed
 * `background-color`; ours is a translucent black meant to sit on the modal's
 * blurred sheet, so the popup composited it over its own white base and the
 * list came out light gray inside an app that is dark everywhere else.
 * `color-scheme: dark` never reaches that window — there is nothing to style
 * from here.
 *
 * So the list is ours: the same blurred `.menu` material as the context menu,
 * portaled to `<body>` (a `position: fixed` child would be trapped by the
 * modal's `backdrop-filter`) and driven from the keyboard like a real
 * listbox.
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
import { Check, ChevronsUpDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  /** Heading above the option; options in a row sharing it get one heading. */
  group?: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  /** Extra class on the trigger, for callers that reshape the control. */
  className?: string;
  /** Accessible name, for triggers with no visible `<label>` around them. */
  label?: string;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** Balloon text, same `data-tip` the rest of the chrome uses. */
  tip?: string;
  /** Drawn inside the trigger, before the value: a brand mark, a glyph. */
  icon?: ReactNode;
  /**
   * Muted text pinned to the right of the value, before the caret: the path
   * of a project, the slug of a repository. It is a second line of the same
   * answer, never a second answer, so it is `title`d and ellipsised rather
   * than allowed to push the value out of the field.
   */
  hint?: string;
}

/** Breathing room against the window edge, and the gap to the trigger. */
const PAD = 8;
const GAP = 5;

interface Pos {
  left: number;
  top: number;
  minWidth: number;
  maxHeight: number;
  up: boolean;
}

/** Below the trigger while it fits there, above it when the room is up. */
function place(anchor: DOMRect, height: number, width: number): Pos {
  const below = window.innerHeight - anchor.bottom - GAP - PAD;
  const above = anchor.top - GAP - PAD;
  const up = height > below && above > below;
  const maxHeight = Math.max(140, up ? above : below);
  const w = Math.max(width, anchor.width);
  return {
    left: Math.max(PAD, Math.min(anchor.left, window.innerWidth - w - PAD)),
    top: up ? anchor.top - GAP - Math.min(height, maxHeight) : anchor.bottom + GAP,
    minWidth: anchor.width,
    maxHeight,
    up,
  };
}

export function Select({
  value,
  options,
  onChange,
  id,
  className,
  label,
  placeholder,
  disabled,
  tip,
  icon,
  hint,
}: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const anchor = useRef<DOMRect | null>(null);
  /** The highlight moved by key, not by hover — see the scroll effect. */
  const byKey = useRef(false);
  const listId = useId();

  const [pos, setPos] = useState<Pos | null>(null);
  const open = pos !== null;
  const [activeValue, setActiveValue] = useState<string | null>(null);

  const selected = options.find((o) => o.value === value);
  const enabled = options.filter((o) => !o.disabled);
  const activeIndex = options.findIndex((o) => o.value === activeValue);

  const closeList = useCallback((refocus = true) => {
    setPos(null);
    if (refocus) trigger.current?.focus();
  }, []);

  const openList = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    anchor.current = rect;
    byKey.current = true;
    setActiveValue(selected?.value ?? enabled[0]?.value ?? null);
    setPos(place(rect, 0, 0));
  };

  const pick = (option: SelectOption) => {
    if (option.disabled) return;
    closeList();
    if (option.value !== value) onChange(option.value);
  };

  /**
   * `scrollHeight`, not `offsetHeight`: the first guess already clamped the
   * element to the room below the trigger, and a clamped height would never
   * ask to flip upward.
   */
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !anchor.current) return;
    setPos(place(anchor.current, el.scrollHeight + 2, el.offsetWidth));
    // Runs once per opening — `pos` is this effect's own output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length]);

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  // Opening on the current value, or walking with the arrows, must not leave
  // the row out of sight in a list taller than the screen. Only for the
  // keyboard: chasing the mouse would nudge the list under the pointer every
  // time it grazed a half-visible row.
  useEffect(() => {
    if (!open || !activeValue || !byKey.current) return;
    byKey.current = false;
    list.current
      ?.querySelector<HTMLElement>(`[data-value="${CSS.escape(activeValue)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeValue]);

  useEffect(() => {
    if (!open) return;
    const outside = (t: EventTarget | null) =>
      !(t instanceof Node) ||
      (!list.current?.contains(t) && !trigger.current?.contains(t));
    const onDown = (e: Event) => {
      if (outside(e.target)) closeList(false);
    };
    // Scrolling the panel behind the list leaves it pointing at nothing: the
    // position was resolved once, against a trigger that has since moved.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && list.current?.contains(e.target)) return;
      closeList(false);
    };
    const onLeave = () => closeList(false);
    // Next tick: the pointerdown that opened the list must not close it in
    // the same interaction.
    const tid = window.setTimeout(() => {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onLeave);
      window.addEventListener("blur", onLeave);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [open, closeList]);

  const highlight = (option: SelectOption | undefined) => {
    if (!option) return;
    byKey.current = true;
    setActiveValue(option.value);
  };

  const move = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const i = enabled.findIndex((o) => o.value === activeValue);
    highlight(enabled[(i + dir + enabled.length) % enabled.length]);
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") {
      // Without the `stopPropagation` the `Escape` would reach the Modal's
      // window listener and close the whole dialog along with the list.
      e.preventDefault();
      e.stopPropagation();
      closeList();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      highlight(enabled[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      highlight(enabled[enabled.length - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = enabled.find((o) => o.value === activeValue);
      if (option) pick(option);
    }
  };

  // Runs of options sharing a `group` become one `role="group"`; a listbox
  // may only hold options and groups, never a loose heading.
  const groups: { name?: string; items: { option: SelectOption; index: number }[] }[] =
    [];
  options.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === option.group) last.items.push({ option, index });
    else groups.push({ name: option.group, items: [{ option, index }] });
  });

  const row = (option: SelectOption, index: number) => (
    <button
      key={option.value}
      id={`${listId}-${index}`}
      type="button"
      role="option"
      data-value={option.value}
      aria-selected={option.value === value}
      disabled={option.disabled}
      className={option.value === activeValue ? "is-active" : ""}
      onMouseEnter={() => !option.disabled && setActiveValue(option.value)}
      onClick={() => pick(option)}
    >
      <span className="menu-icon">
        {option.value === value && <Check size={13} aria-hidden="true" />}
      </span>
      <span className="menu-label">{option.label}</span>
    </button>
  );

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        className={`select-trigger${open ? " is-open" : ""}${
          className ? ` ${className}` : ""
        }`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        data-tip={tip}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          }
        }}
      >
        {icon}
        <span className="select-value">
          {selected ? (
            selected.label
          ) : (
            <span className="select-ph">{placeholder ?? "—"}</span>
          )}
        </span>
        {hint && (
          <span className="select-hint" title={hint}>
            {hint}
          </span>
        )}
        <ChevronsUpDown size={12} className="select-caret" aria-hidden="true" />
      </button>

      {pos &&
        createPortal(
          <div
            ref={list}
            id={listId}
            className={`menu menu--popup menu--select${pos.up ? " is-up" : ""}`}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={
              activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
            }
            style={{
              left: pos.left,
              top: pos.top,
              minWidth: pos.minWidth,
              maxHeight: pos.maxHeight,
            }}
            onKeyDown={onListKeyDown}
          >
            {groups.map((g, gi) =>
              g.name === undefined ? (
                g.items.map(({ option, index }) => row(option, index))
              ) : (
                <div
                  key={`g-${gi}`}
                  className="select-group"
                  role="group"
                  aria-label={g.name}
                >
                  <div className="menu-head">{g.name}</div>
                  {g.items.map(({ option, index }) => row(option, index))}
                </div>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
