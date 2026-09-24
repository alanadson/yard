/** Copy modifiers explicitly: native event properties are not enumerable. */
export function canvasKeyEvent(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
) {
  return {
    code:
      event.code === "Numpad0"
        ? "Digit0"
        : event.code === "NumpadAdd"
          ? "Equal"
          : event.code === "NumpadSubtract"
            ? "Minus"
            : event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}

/**
 * Space on a focused button (or link) is that control's click. The board
 * only owns the key when focus sits on the board itself or on nothing.
 */
export function spaceActivatesTarget(target: { tagName?: string } | null | undefined): boolean {
  const tag = target?.tagName;
  return tag === "BUTTON" || tag === "A";
}
