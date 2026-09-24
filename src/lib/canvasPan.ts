export function backgroundPan(
  button: number,
  onBackground: boolean,
  spaceHeld: boolean,
  tool: string,
): boolean {
  return (
    button === 1 ||
    (button === 2 && onBackground) ||
    (button === 0 && (spaceHeld || tool === "pan"))
  );
}

export function suppressPanMenu(
  button: number,
  dx: number,
  dy: number,
  alreadyDragged: boolean,
): boolean {
  return alreadyDragged || (button === 2 && Math.hypot(dx, dy) >= 4);
}
