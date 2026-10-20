/** Pricing provenance must stay attached to the exact rates displayed to the user. */
import { expect, it } from "vitest";
import * as pricing from "./pricing";

it("accepts a complete custom price draft with decimal commas and explicit free categories", () => {
  expect(pricing.parseCustomRate({ model: "  CLAUDE-SONNET-5-5  ", input: "1,5", output: "3",
    cacheRead: "0", cacheWriteFiveMinute: "1.8", cacheWriteOneHour: "2,5" })).toEqual({
    model: "claude-sonnet-5-5", input: 1.5, output: 3, cacheRead: 0, cacheWriteFiveMinute: 1.8, cacheWriteOneHour: 2.5,
  });
});

it("rejects incomplete or invalid custom price drafts instead of silently saving free categories", () => {
  const draft = { model: "claude-sonnet-5-5", input: "1", output: "3", cacheRead: "0", cacheWriteFiveMinute: "1.5", cacheWriteOneHour: "2.5" };
  for (const value of ["", " ", "-1", "Infinity", "NaN", "1000001", "1,000,000"]) {
    expect(pricing.parseCustomRate({ ...draft, input: value })).toBeNull();
  }
  for (const model of ["", "model\nname", "x".repeat(161)]) expect(pricing.parseCustomRate({ ...draft, model })).toBeNull();
});

it("shows custom rates separately from verified provenance and includes explicitly configured unknown models", () => {
  const verified = { model: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, cacheWriteFiveMinute: 2.5, cacheWriteOneHour: 4,
    verifiedOn: "2026-10-06", inheritedOn: null, source: "https://platform.claude.com/docs/en/about-claude/pricing" };
  const custom = { model: verified.model, input: 1, output: 3, cacheRead: 0.1, cacheWriteFiveMinute: 1.5, cacheWriteOneHour: 2 };
  const extra = { ...custom, model: "custom-model" };
  const visible = pricing.effectivePriceModels([verified], [custom, extra]);
  expect(visible).toEqual([{ ...verified, ...custom, custom: true, verifiedOn: null, inheritedOn: null, source: null },
    { ...extra, custom: true, verifiedOn: null, inheritedOn: null, source: null }]);
  expect(verified.input).toBe(2);
  expect(pricing.effectivePriceModels([verified], [])).toEqual([{ ...verified, custom: false }]);
});

it("replaces only the selected custom model while preserving other configured rates", () => {
  const original = { model: "claude-sonnet-5-5", input: 2, output: 10, cacheRead: 0.2, cacheWriteFiveMinute: 2.5, cacheWriteOneHour: 4 };
  const other = { ...original, model: "custom-model" };
  const edited = { ...original, input: 1 };
  const result = pricing.upsertCustomRate([original, other], edited);
  expect(result).toEqual([other, edited]);
  expect(original.input).toBe(2);
});

it("finds a model by case-insensitive release text without changing reference order", () => {
  const models = [{ model: "claude-opus-5-5" }, { model: "claude-sonnet-5-5" }, { model: "claude-opus-4-5" }];
  expect(pricing.filterPriceModels(models, "  OPUS  ")).toEqual([models[0], models[2]]);
  expect(pricing.filterPriceModels(models, "")).toEqual(models);
  expect(pricing.filterPriceModels(models, "opus-9")).toEqual([]);
});

it.each([
  [{ verifiedOn: null, inheritedOn: "2026-08-12", source: null }, { kind: "inherited", date: "2026-08-12" }],
  [{ verifiedOn: "2026-10-06", inheritedOn: null, source: "https://platform.claude.com/docs/en/about-claude/pricing" }, { kind: "verified", date: "2026-10-06", source: "https://platform.claude.com/docs/en/about-claude/pricing" }],
])("classifies a price reference by its actual verification provenance (%j)", (reference, expected) => {
  expect(pricing.priceProvenance(reference)).toEqual(expected);
});
