// Surface disposal must not clear a newer host's view or destroy a view twice.
import { expect, it } from "vitest";
import { ownSurface } from "./surfaceCore";

it("releases only references owned by the departing surface and destroys once", () => {
  let destroyed = 0;
  const view = {
    destroy: () => {
      destroyed++;
    },
  };
  const replacement = { destroy: () => {} };
  const local = { current: null as typeof view | null };
  const publicView = { current: null as typeof view | null };
  const release = ownSurface(view, [local, publicView]);
  expect(local.current).toBe(view);
  publicView.current = replacement;
  release();
  release();
  expect(destroyed).toBe(1);
  expect(local.current).toBeNull();
  expect(publicView.current).toBe(replacement);
});
