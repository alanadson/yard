/**
 * The tooltip balloon on the page: one `.tip-layer` in `<body>`, fed by every
 * `data-tip` in the app.
 *
 * Everything that is a decision (what the control asks for, where the
 * balloon goes, whether it opens) lives in `tip.ts`, tested. This file is
 * the wiring around it: the listeners on the document, the timer, the
 * measurement. One balloon and one set of listeners for the whole app
 * (installed once, by `App`), never one per control: the old `::after` was
 * per control, and a `::after` cannot leave the scrollport or the stacking
 * context it was born in: the sidebar tree cut its balloons at the edge and
 * the title bar's doors opened theirs under the bench.
 *
 * Above every DOM panel, that is. A portal's page is an OS window parented to
 * the main one, and no z-index reaches it: the browser pane's toolbar hints
 * opened their balloon straight into the page under the toolbar, which
 * painted over all but a sliver. So, open, the balloon publishes its
 * rectangle to `occludersStore` like a menu does, and the portals under it
 * cut a hole; closed, it retires it.
 *
 * The listeners are in the capture phase on purpose: a component that stops
 * propagation of its pointer events must not starve the balloon of the
 * crossing it needs to close.
 */
import { placeTip, tipRequest, tipStep, TIP_DELAY, type TipEvent, type TipState } from "./tip";
import { useOccluders } from "../stores/occludersStore";

/** The balloon's entry in `occludersStore`: there is one balloon, so one key. */
const OCCLUDER_KEY = "tip";

export function startTipLayer(): () => void {
  const layer = document.createElement("div");
  layer.className = "tip-layer";
  // Visual only: the control's `aria-label` is what the screen reader hears.
  layer.setAttribute("aria-hidden", "true");
  layer.hidden = true;
  document.body.appendChild(layer);

  let state: TipState<Element> = { phase: "idle" };
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The control with a hint under `target`, if it still has something to say. */
  const anchorOf = (target: EventTarget | null): Element | null => {
    if (!(target instanceof Element)) return null;
    const el = target.closest("[data-tip]");
    return el && tipRequest(el) ? el : null;
  };

  /** Gone, or with nothing left to say: a re-render between arming and opening. */
  const stale = (anchor: Element) => !anchor.isConnected || !tipRequest(anchor);

  const show = (anchor: Element) => {
    const req = tipRequest(anchor);
    if (!req) return;
    layer.textContent = req.text;
    layer.classList.toggle("is-wrap", req.wrap);
    // Measured with the bridge on the asked side. A flip stays on the same
    // axis, so the size measured here holds for the side it ends up on.
    layer.dataset.side = req.side;
    layer.style.left = "0px";
    layer.style.top = "0px";
    layer.hidden = false;
    const size = layer.getBoundingClientRect();
    const placed = placeTip(
      anchor.getBoundingClientRect(),
      size,
      { width: window.innerWidth, height: window.innerHeight },
      req,
    );
    layer.dataset.side = placed.side;
    layer.style.left = `${placed.x}px`;
    layer.style.top = `${placed.y}px`;
    useOccluders
      .getState()
      .setOccluder(OCCLUDER_KEY, { x: placed.x, y: placed.y, w: size.width, h: size.height });
  };

  const hide = () => {
    layer.hidden = true;
    useOccluders.getState().setOccluder(OCCLUDER_KEY, null);
  };

  const dispatch = (event: TipEvent<Element>) => {
    const prev = state;
    const next = tipStep(prev, event);
    if (next === prev) return;
    state = next;
    const before = prev.phase === "idle" ? null : prev.anchor;
    const after = next.phase === "idle" ? null : next.anchor;
    const stillArmed = prev.phase === "armed" && next.phase === "armed" && before === after;
    const stillOpen = prev.phase === "open" && next.phase === "open" && before === after;
    if (prev.phase === "armed" && !stillArmed && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (prev.phase === "open" && !stillOpen) hide();
    if (next.phase === "armed" && !stillArmed) timer = setTimeout(onTimer, TIP_DELAY);
    if (next.phase === "open" && !stillOpen) show(next.anchor);
  };

  const onTimer = () => {
    timer = null;
    if (state.phase === "armed" && stale(state.anchor)) dispatch({ type: "leave" });
    else dispatch({ type: "timer" });
  };

  const onPointerOver = (e: PointerEvent) => {
    dispatch({
      type: "arrive",
      anchor: anchorOf(e.target),
      inBalloon: e.target instanceof Node && layer.contains(e.target),
      buttons: e.buttons,
    });
  };
  /** `relatedTarget` is null only when the pointer left the page. */
  const onPointerOut = (e: PointerEvent) => {
    if (e.relatedTarget === null) dispatch({ type: "leave" });
  };
  /** No event says a hovered control was removed; the next move checks. */
  const onPointerMove = () => {
    if (state.phase !== "idle" && stale(state.anchor)) dispatch({ type: "leave" });
  };
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (!(target instanceof Element) || !target.matches(":focus-visible")) return;
    const anchor = anchorOf(target);
    if (anchor) dispatch({ type: "focus", anchor });
  };
  const onFocusOut = (e: FocusEvent) => {
    const anchor = anchorOf(e.target);
    if (anchor) dispatch({ type: "blur", anchor });
  };
  const close = () => dispatch({ type: "close" });
  /** No `preventDefault`: the same Esc keeps closing whatever layer owns it. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  /**
   * A scroll moves the control out from under a fixed balloon, but only a
   * scroll of the control's own scrollport counts: terminals scroll on their
   * own all day, and a hint in the sidebar has nothing to do with that.
   */
  const onScroll = (e: Event) => {
    if (state.phase === "idle") return;
    if (e.target instanceof Node && e.target.contains(state.anchor)) close();
  };

  const capture = { capture: true } as const;
  const passive = { capture: true, passive: true } as const;
  document.addEventListener("pointerover", onPointerOver, capture);
  document.addEventListener("pointerout", onPointerOut, capture);
  document.addEventListener("pointermove", onPointerMove, passive);
  document.addEventListener("pointerdown", close, capture);
  document.addEventListener("wheel", close, passive);
  document.addEventListener("scroll", onScroll, passive);
  document.addEventListener("focusin", onFocusIn, capture);
  document.addEventListener("focusout", onFocusOut, capture);
  window.addEventListener("keydown", onKeyDown, capture);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);

  return () => {
    document.removeEventListener("pointerover", onPointerOver, capture);
    document.removeEventListener("pointerout", onPointerOut, capture);
    document.removeEventListener("pointermove", onPointerMove, passive);
    document.removeEventListener("pointerdown", close, capture);
    document.removeEventListener("wheel", close, passive);
    document.removeEventListener("scroll", onScroll, passive);
    document.removeEventListener("focusin", onFocusIn, capture);
    document.removeEventListener("focusout", onFocusOut, capture);
    window.removeEventListener("keydown", onKeyDown, capture);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
    if (timer !== null) clearTimeout(timer);
    hide();
    layer.remove();
  };
}
