/** Display the same model reference that the native usage estimator consumes. */
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import { useUI } from "../../stores/uiStore";
import { usePricing } from "../../stores/pricingStore";
import { usePricingSettings } from "../../stores/pricingSettingsStore";
import { useCosts } from "../../stores/costsStore";
import { effectivePriceModels, filterPriceModels, parseCustomRate, PRICE_CATEGORIES, priceProvenance, upsertCustomRate, type CustomRate, type CustomRateDraft, type PriceCategory } from "../../lib/pricing";
import { formatUsd } from "../../lib/costs";
import "./pricing.css";

// i18n-scan: tables, translated when the category is rendered.
const CATEGORY_LABELS: Record<PriceCategory, string> = { input: "Entrada", output: "Saída", cacheRead: "Cache lido",
  cacheWriteFiveMinute: "Cache gravado, 5 min", cacheWriteOneHour: "Cache gravado, 1 h" };
const draftOf = (rate: CustomRate): CustomRateDraft => ({ model: rate.model, input: String(rate.input), output: String(rate.output),
  cacheRead: String(rate.cacheRead), cacheWriteFiveMinute: String(rate.cacheWriteFiveMinute), cacheWriteOneHour: String(rate.cacheWriteOneHour) });

export function PricingModal() {
  const t = useT();
  const close = useUI((state) => state.closeModal);
  const reference = usePricing((state) => state.reference);
  const loading = usePricing((state) => state.loading);
  const error = usePricing((state) => state.error);
  const load = usePricing((state) => state.load);
  const settings = usePricingSettings((state) => state.settings);
  const settingsLoading = usePricingSettings((state) => state.loading);
  const saving = usePricingSettings((state) => state.saving);
  const settingsError = usePricingSettings((state) => state.error);
  const loadSettings = usePricingSettings((state) => state.load);
  const save = usePricingSettings((state) => state.save);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ draft: CustomRateDraft; revision: number } | null>(null);
  useEffect(() => { void load(); void loadSettings(); }, [load, loadSettings]);
  const models = filterPriceModels(effectivePriceModels(reference?.models ?? [], settings?.rates ?? []), query);
  const valid = editing ? parseCustomRate(editing.draft) : null;
  const edit = (rate?: CustomRate) => {
    if (!settings) return;
    setEditing({ revision: settings.revision, draft: rate ? draftOf(rate) : { model: "", input: "", output: "", cacheRead: "", cacheWriteFiveMinute: "", cacheWriteOneHour: "" } });
  };
  const persist = async () => {
    if (!valid || !settings || !editing) return;
    if (await save(upsertCustomRate(settings.rates, valid), editing.revision)) {
      setEditing(null);
      void useCosts.getState().refresh();
    }
  };
  const reset = async (model: string) => {
    if (!settings) return;
    if (await save(settings.rates.filter((rate) => rate.model.toLowerCase() !== model.toLowerCase()), settings.revision)) void useCosts.getState().refresh();
  };
  return <Modal title={t("Referência de preços")} onClose={close} wide dirty={!!editing} initialFocus=".pricing-search"
    toolbar={<div className="pricing-toolbar">
      <input className="pricing-search" aria-label={t("Buscar modelo")} placeholder={t("Buscar modelo")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="btn btn--sm" disabled={!settings || saving || settingsLoading || !!editing} onClick={() => edit()}>{t("Nova tarifa")}</button>
      <button className="icon-btn" aria-label={t("Atualizar")} disabled={loading || settingsLoading || saving} onClick={() => { void load(); void loadSettings(); }}><RefreshCw size={14} /></button>
    </div>}
    footer={<p className="hint pricing-note">{t("Preços de API padrão, região global, em USD por milhão de tokens. Contratos, planos de assinatura, outros provedores, lotes, prioridade e região podem ter valores diferentes.")}</p>}>
    {error && <p className="hint hint--error" role="alert">{t("Não consegui ler os preços: {error}.", { error })}</p>}
    {settingsError && <p className="hint hint--error" role="alert">{t("Não consegui salvar ou carregar as tarifas. Cancele a edição e atualize os preços antes de tentar novamente.")}</p>}
    {loading && !reference && <p className="hint" role="status">{t("Lendo referência de preços…")}</p>}
    {editing ? <form className="pricing-editor" aria-label={t("Editar tarifa personalizada")} onSubmit={(event) => { event.preventDefault(); void persist(); }}>
      <h4>{t("Tarifa personalizada")}</h4>
      <p className="hint">{t("Informe USD por milhão de tokens em todos os campos. Ao salvar, os custos são recalculados com estes valores; os tokens permanecem os mesmos.")}</p>
      <label>{t("Modelo")}<input aria-label={t("Modelo da tarifa")} value={editing.draft.model} disabled={saving} maxLength={160}
        onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, model: event.target.value } })} /></label>
      <div className="pricing-fields">{PRICE_CATEGORIES.map((key) => <label key={key}>{t(CATEGORY_LABELS[key])}
        <input inputMode="decimal" aria-label={t(CATEGORY_LABELS[key])} value={editing.draft[key]} disabled={saving}
          onChange={(event) => setEditing({ ...editing, draft: { ...editing.draft, [key]: event.target.value } })} />
      </label>)}</div>
      <div className="pricing-actions"><button type="submit" className="btn btn--primary" disabled={!valid || saving}>{saving ? t("Salvando…") : t("Salvar tarifas")}</button>
        <button type="button" className="btn" disabled={saving} onClick={() => setEditing(null)}>{t("Cancelar edição")}</button></div>
    </form> : reference && <>
      <p className="hint pricing-version">{t("Versão: {version}", { version: reference.version })}</p>
      <div className="pricing-models">
        {models.map((model) => {
          const provenance = priceProvenance(model);
          return <section className="pricing-model" key={model.model} aria-label={model.model}>
            <h4>{model.model}</h4>
            <dl>
              <div><dt>{t("Entrada")}</dt><dd>{formatUsd(model.input)}</dd></div>
              <div><dt>{t("Saída")}</dt><dd>{formatUsd(model.output)}</dd></div>
              <div><dt>{t("Cache lido")}</dt><dd>{formatUsd(model.cacheRead)}</dd></div>
              <div><dt>{t("Cache gravado, 5 min")}</dt><dd>{formatUsd(model.cacheWriteFiveMinute)}</dd></div>
              <div><dt>{t("Cache gravado, 1 h")}</dt><dd>{formatUsd(model.cacheWriteOneHour)}</dd></div>
            </dl>
            <p className="hint">{model.custom ? t("Tarifa personalizada salva, revisão {revision}", { revision: settings?.revision ?? 0 }) : provenance.kind === "verified" ? t("Conferido em {date}", { date: provenance.date })
              : provenance.kind === "inherited" ? t("Referência antiga de {date}, sem nova conferência", { date: provenance.date }) : t("Origem não informada")}</p>
            {provenance.kind === "verified" && <p className="hint pricing-source">{provenance.source}</p>}
            <div className="pricing-actions"><button className="btn btn--sm" disabled={!settings || saving || settingsLoading} onClick={() => edit(model)}>{t("Personalizar tarifa")}</button>
              {model.custom && <button className="btn btn--sm" disabled={saving || settingsLoading} onClick={() => void reset(model.model)}>{t("Remover tarifa personalizada")}</button>}
            </div>
          </section>;
        })}
      </div>
      {models.length === 0 && <p className="hint">{t("Nenhum modelo encontrado.")}</p>}
    </>}
  </Modal>;
}
