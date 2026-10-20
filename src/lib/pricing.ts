/** Price reference provenance belongs to each model, including inherited legacy rates. */
export interface ModelPriceReference {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWriteFiveMinute: number;
  cacheWriteOneHour: number;
  verifiedOn: string | null;
  inheritedOn: string | null;
  source: string | null;
}

export interface PricingReference {
  version: string;
  currency: string;
  provider: string;
  scope: string;
  models: ModelPriceReference[];
}

export type CustomRate = Pick<ModelPriceReference, "model" | "input" | "output" | "cacheRead" | "cacheWriteFiveMinute" | "cacheWriteOneHour">;
export type PriceCategory = Exclude<keyof CustomRate, "model">;
export const PRICE_CATEGORIES: readonly PriceCategory[] = ["input", "output", "cacheRead", "cacheWriteFiveMinute", "cacheWriteOneHour"];
export type CustomRateDraft = Record<keyof CustomRate, string>;
export interface PricingSettings { revision: number; rates: CustomRate[] }

export type EffectivePriceModel = ModelPriceReference & { custom: boolean };

export function upsertCustomRate(rates: readonly CustomRate[], rate: CustomRate): CustomRate[] {
  return [...rates.filter((current) => current.model.toLowerCase() !== rate.model.toLowerCase()), rate];
}

export function effectivePriceModels(models: readonly ModelPriceReference[], custom: readonly CustomRate[]): EffectivePriceModel[] {
  const override = (rate: CustomRate): EffectivePriceModel => ({ ...rate, custom: true, verifiedOn: null, inheritedOn: null, source: null });
  const result = models.map((model) => {
    const own = custom.find((rate) => rate.model.toLowerCase() === model.model.toLowerCase());
    return own ? override(own) : { ...model, custom: false };
  });
  for (const rate of custom) if (!result.some((model) => model.model.toLowerCase() === rate.model.toLowerCase())) result.push(override(rate));
  return result;
}

export function parseCustomRate(draft: CustomRateDraft): CustomRate | null {
  const model = draft.model.trim().toLowerCase();
  if (!model || model.length > 160 || !/^[a-z0-9_.:/-]+$/.test(model)) return null;
  if (PRICE_CATEGORIES.some((key) => !/^\d+(?:[.,]\d+)?$/.test(draft[key].trim()))) return null;
  const number = (key: PriceCategory) => Number(draft[key].trim().replace(",", "."));
  if (PRICE_CATEGORIES.some((key) => !Number.isFinite(number(key)) || number(key) > 1_000_000)) return null;
  return { model, input: number("input"), output: number("output"),
    cacheRead: number("cacheRead"), cacheWriteFiveMinute: number("cacheWriteFiveMinute"), cacheWriteOneHour: number("cacheWriteOneHour") };
}

export function filterPriceModels<T extends { model: string }>(models: readonly T[], query: string): T[] {
  const text = query.trim().toLowerCase();
  return models.filter((entry) => entry.model.toLowerCase().includes(text));
}

export type PriceProvenance = { kind: "verified"; date: string; source: string } | { kind: "inherited"; date: string } | { kind: "unknown" };

export function priceProvenance(reference: Pick<ModelPriceReference, "verifiedOn" | "inheritedOn" | "source">): PriceProvenance {
  if (reference.verifiedOn && reference.source) return { kind: "verified", date: reference.verifiedOn, source: reference.source };
  if (reference.inheritedOn) return { kind: "inherited", date: reference.inheritedOn };
  return { kind: "unknown" };
}
