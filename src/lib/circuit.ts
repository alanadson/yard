/** Orthogonal routes shared by painting, selection and erasing. */
import type { Box } from "./canvas";

export interface CircuitPoint {
  x: number;
  y: number;
}

export function circuitPoints(
  a: Box,
  b: Box,
  via?: CircuitPoint,
): CircuitPoint[] {
  if (via) {
    const anchor = { ...via, w: 0, h: 0 };
    return [...circuitPoints(a, anchor), ...circuitPoints(anchor, b).slice(1)];
  }
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  if (Math.abs(bc.y - ac.y) > Math.abs(bc.x - ac.x)) {
    const direction = bc.y >= ac.y ? 1 : -1;
    const start = { x: ac.x, y: ac.y + (direction * a.h) / 2 };
    const end = { x: bc.x, y: bc.y - (direction * b.h) / 2 };
    const mid = (start.y + end.y) / 2;
    return [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  const sign = bc.x >= ac.x ? 1 : -1;
  const start = { x: ac.x + (sign * a.w) / 2, y: ac.y };
  const end = { x: bc.x - (sign * b.w) / 2, y: bc.y };
  const mid = (start.x + end.x) / 2;
  return [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
}
