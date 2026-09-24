/** Circuit wires must meet card borders and remain selectable along their actual route. */
import { expect, it } from "vitest";
import { circuitPoints } from "./circuit";

it("uses top and bottom ports when the cards are arranged vertically", () => {
  expect(
    circuitPoints(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 80, y: 400, w: 100, h: 100 },
    ),
  ).toEqual([
    { x: 50, y: 100 },
    { x: 50, y: 250 },
    { x: 130, y: 250 },
    { x: 130, y: 400 },
  ]);
});

it("routes a horizontal gap with two right-angle bends between the facing borders", () => {
  expect(
    circuitPoints(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 400, y: 100, w: 100, h: 100 },
    ),
  ).toEqual([
    { x: 100, y: 50 },
    { x: 250, y: 50 },
    { x: 250, y: 150 },
    { x: 400, y: 150 },
  ]);
});
