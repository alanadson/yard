// CLI tiles must follow their rendered rows, including narrower responsive layouts.
import { expect, it } from "vitest";
import { gridNeighbor } from "./gridNavigation";

it("moves vertically to the nearest tile in the next visual row and retains focus at an edge", () => {
  const tiles = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 100, y: 0 },
    { id: "c", x: 0, y: 100 },
    { id: "d", x: 100, y: 100 },
    { id: "e", x: 0, y: 240 },
  ];
  expect(gridNeighbor(tiles, "b", "ArrowDown")).toBe("d");
  expect(gridNeighbor(tiles, "d", "ArrowUp")).toBe("b");
  expect(gridNeighbor(tiles, "d", "ArrowLeft")).toBe("c");
  expect(gridNeighbor(tiles, "a", "ArrowUp")).toBe("a");
  expect(gridNeighbor(tiles, "d", "ArrowDown")).toBe("e");
  expect(
    gridNeighbor(
      tiles.map((tile, index) => ({ ...tile, x: 0, y: index * 100 })),
      "b",
      "ArrowDown",
    ),
  ).toBe("c");
});
