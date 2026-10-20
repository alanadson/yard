/** A failed reference read must retain the exact last known pricing data for review. */
import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ pricingReference: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));
import * as store from "./pricingStore";

beforeEach(() => { boundary.pricingReference.mockReset(); store.usePricing.setState({ reference: null, error: null, loading: false }); });

it("keeps the newer pricing reference when an earlier read finishes afterward", async () => {
  const reference = { version: "newer", provider: "anthropic", currency: "USD", scope: "api-standard-global", models: [] };
  let finish!: (value: typeof reference) => void;
  boundary.pricingReference.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  boundary.pricingReference.mockResolvedValueOnce(reference);
  const earlier = store.usePricing.getState().load();
  await store.usePricing.getState().load();
  finish({ ...reference, version: "older" });
  await earlier;
  expect(store.usePricing.getState().reference?.version).toBe("newer");
});

it("retains the last pricing reference and exposes an error when refreshing fails", async () => {
  const reference = { version: "reference-v1", provider: "anthropic", currency: "USD", scope: "api-standard-global", models: [] };
  boundary.pricingReference.mockResolvedValueOnce(reference);
  await store.usePricing.getState().load();
  boundary.pricingReference.mockRejectedValueOnce(new Error("Reference unavailable"));
  await store.usePricing.getState().load();
  expect(store.usePricing.getState().reference).toEqual(reference);
  expect(store.usePricing.getState().error).toBe("Reference unavailable");
});
