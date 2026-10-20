/** Custom prices become visible only after native persistence acknowledges the saved revision. */
import { beforeEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ pricingSettings: vi.fn(), pricingSettingsSave: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));
import * as store from "./pricingSettingsStore";
import type { CustomRate, PricingSettings } from "../lib/pricing";

const custom: CustomRate = { model: "claude-sonnet-5-5", input: 1, output: 3, cacheRead: 0.2, cacheWriteFiveMinute: 1.5, cacheWriteOneHour: 2.5 };
beforeEach(() => {
  boundary.pricingSettings.mockReset(); boundary.pricingSettingsSave.mockReset();
  store.usePricingSettings.setState({ settings: null, loading: false, saving: false, error: null });
});

it("publishes custom rates only after the native save acknowledges their new revision", async () => {
  boundary.pricingSettings.mockResolvedValue({ revision: 3, rates: [] });
  await store.usePricingSettings.getState().load();
  let finish!: (settings: PricingSettings) => void;
  boundary.pricingSettingsSave.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const saving = store.usePricingSettings.getState().save([custom]);
  expect(store.usePricingSettings.getState().saving).toBe(true);
  expect(store.usePricingSettings.getState().settings).toEqual({ revision: 3, rates: [] });
  finish({ revision: 4, rates: [custom] });
  expect(await saving).toBe(true);
  expect(store.usePricingSettings.getState().settings).toEqual({ revision: 4, rates: [custom] });
  expect(store.usePricingSettings.getState().saving).toBe(false);
});

it("does not let a read started before saving replace the acknowledged custom rates", async () => {
  store.usePricingSettings.setState({ settings: { revision: 3, rates: [] } });
  let finish!: (settings: PricingSettings) => void;
  boundary.pricingSettings.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const reading = store.usePricingSettings.getState().load();
  boundary.pricingSettingsSave.mockResolvedValue({ revision: 4, rates: [custom] });
  await store.usePricingSettings.getState().save([custom]);
  finish({ revision: 3, rates: [] });
  await reading;
  expect(store.usePricingSettings.getState().settings).toEqual({ revision: 4, rates: [custom] });
});

it("saves against the revision reviewed by the editor instead of silently adopting a newer revision", async () => {
  store.usePricingSettings.setState({ settings: { revision: 4, rates: [custom] } });
  boundary.pricingSettingsSave.mockImplementation((revision: number) => revision === 3
    ? Promise.reject(new Error("STALE_PRICING_REVISION")) : Promise.resolve({ revision: 5, rates: [] }));
  expect(await store.usePricingSettings.getState().save([], 3)).toBe(false);
  expect(store.usePricingSettings.getState().settings).toEqual({ revision: 4, rates: [custom] });
  expect(store.usePricingSettings.getState().error).toBe("STALE_PRICING_REVISION");
});
