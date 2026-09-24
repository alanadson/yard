/** Centers measured from the current layout avoid assumptions about column count. */
export function gridNeighbor(
  tiles: readonly { id: string; x: number; y: number }[],
  active: string,
  key: string,
): string {
  const origin = tiles.find((tile) => tile.id === active);
  if (!origin) return tiles[0]?.id ?? active;
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  const ranked = tiles
    .map((tile) => {
      const main =
        (horizontal ? tile.x - origin.x : tile.y - origin.y) * direction;
      const cross = Math.abs(
        horizontal ? tile.y - origin.y : tile.x - origin.x,
      );
      return { tile, main, score: main + cross * 4 };
    })
    .filter(({ main }) => main > 1)
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.tile.id ?? active;
}
