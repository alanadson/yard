/**
 * "Custos e uso" — tokens and estimated spend over the last day, week or
 * month, per day, project, agent and model.
 *
 * The rows come from `costs.rs` (one per local day × agent × project ×
 * model) and every number on screen is folded by `lib/costs.ts`; this file
 * is only the drawing. One accent for the bars (cost, or tokens when nothing
 * in the window has a price), tabular figures in the tables, and the caveat
 * the rest of the app already states: list prices, not the invoice.
 */
import { useMemo } from "react";
import "./costs.css";
import { RefreshCw } from "lucide-react";

import { Modal } from "./Modal";
import { useT } from "../../hooks/useT";
import {
  RANGE_LABELS,
  RANGES,
  bucketBy,
  daySeries,
  formatTokens,
  formatUsd,
  totals,
  type Bucket,
  type CostRange,
} from "../../lib/costs";
import { since } from "../../lib/format";
import { useCosts } from "../../stores/costsStore";
import { useUI } from "../../stores/uiStore";

/** A bucket's cost, with the floor marked when part of it had no price. */
function cost(b: Bucket): string {
  if (b.costUsd === null) return "—";
  return b.priced ? formatUsd(b.costUsd) : `≥ ${formatUsd(b.costUsd)}`;
}

export function CostsModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const days = useCosts((s) => s.days);
  const rows = useCosts((s) => s.rows);
  const loading = useCosts((s) => s.loading);
  const error = useCosts((s) => s.error);
  const loadedAt = useCosts((s) => s.loadedAt);
  const setDays = useCosts((s) => s.setDays);
  const refresh = useCosts((s) => s.refresh);

  // Folded once per answer, not per render: the tables are three sorts over
  // the same rows.
  const view = useMemo(() => {
    const now = new Date();
    const series = daySeries(rows, { days, now });
    // Bars measure cost when anything in the window is priced; tokens
    // otherwise — a strip of "—" would say nothing.
    const priced = series.some((p) => p.costUsd !== null);
    const values = series.map((p) => (priced ? (p.costUsd ?? 0) : p.tokens));
    const max = Math.max(0, ...values);
    return {
      total: totals(rows),
      series,
      priced,
      heights: values.map((v) => (max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0)),
      projects: bucketBy(rows, "project"),
      agents: bucketBy(rows, "agent"),
      models: bucketBy(rows, "model"),
    };
  }, [rows, days]);

  const empty = !loading && rows.length === 0;

  const toolbar = (
    <div className="costs-toolbar">
      <div className="costs-seg" role="group" aria-label={t("Período")}>
        {RANGES.map((r: CostRange) => (
          <button
            key={r}
            type="button"
            aria-pressed={days === r}
            onClick={() => void setDays(r)}
          >
            {t(RANGE_LABELS[r])}
          </button>
        ))}
      </div>
      <span className="costs-when">
        {loading
          ? t("lendo as sessões…")
          : loadedAt
            ? t("atualizado {ago}", { ago: since(Math.floor(loadedAt / 1000), Date.now()) })
            : ""}
      </span>
      <button
        className="icon-btn"
        data-tip={t("Ler as sessões de novo")}
        aria-label={t("Atualizar")}
        disabled={loading}
        onClick={() => void refresh()}
      >
        <RefreshCw size={13} className={loading ? "costs-spin" : undefined} />
      </button>
    </div>
  );

  const table = (title: string, buckets: Bucket[], withSessions: boolean) => (
    <section className="costs-section" aria-label={title}>
      <h3>{title}</h3>
      <table className="costs-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">{t("Custo")}</th>
            <th className="num">{t("Entrada")}</th>
            <th className="num">{t("Saída")}</th>
            <th className="num">{t("Cache")}</th>
            {withSessions && <th className="num">{t("Sessões")}</th>}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.key}>
              <td className="costs-name" title={b.key}>
                {b.label}
              </td>
              <td className="num costs-cost">{cost(b)}</td>
              <td className="num">{formatTokens(b.input)}</td>
              <td className="num">{formatTokens(b.output)}</td>
              <td className="num">{formatTokens(b.cacheRead + b.cacheWrite)}</td>
              {withSessions && <td className="num">{b.sessions}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <Modal
      title={t("Custos e uso")}
      onClose={closeModal}
      wide
      toolbar={toolbar}
      footer={
        <p className="hint costs-note">
          {t(
            "Estimativa com preços de tabela (Opus 5, Sonnet 5, Haiku 4.5; cache 1,25× na gravação e 0,1× na leitura) — não bate com a fatura. Um modelo fora da tabela (o Codex, por exemplo) conta tokens e fica sem preço; nas somas ele aparece como piso (≥). Uma sessão que atravessa a meia-noite conta nos dois dias.",
          )}
        </p>
      }
    >
      {error && (
        <p className="hint hint--error" role="alert">
          {t("Não consegui ler as sessões: {error}.", { error })}{" "}
          <button className="linkish" onClick={() => void refresh()}>
            {t("Tentar de novo")}
          </button>
        </p>
      )}

      <div className="costs-tiles" aria-label={t("Totais do período")}>
        <div className="costs-tile costs-tile--main">
          <small>{t("Custo estimado")}</small>
          <strong>{cost(view.total)}</strong>
        </div>
        <div className="costs-tile">
          <small>{t("Entrada")}</small>
          <strong>{formatTokens(view.total.input)}</strong>
        </div>
        <div className="costs-tile">
          <small>{t("Saída")}</small>
          <strong>{formatTokens(view.total.output)}</strong>
        </div>
        <div className="costs-tile">
          <small>{t("Cache lido")}</small>
          <strong>{formatTokens(view.total.cacheRead)}</strong>
        </div>
        <div className="costs-tile">
          <small>{t("Cache gravado")}</small>
          <strong>{formatTokens(view.total.cacheWrite)}</strong>
        </div>
        <div className="costs-tile">
          <small>{t("Sessões")}</small>
          <strong>{view.total.sessions}</strong>
        </div>
      </div>

      {days > 1 && (
        <div
          className="costs-bars"
          role="img"
          aria-label={
            view.priced
              ? t("Custo por dia nos últimos {days} dias", { days })
              : t("Tokens por dia nos últimos {days} dias", { days })
          }
        >
          {view.series.map((p, i) => (
            <div
              key={p.day}
              className="costs-bar"
              title={`${p.label} · ${formatUsd(p.costUsd)} · ${formatTokens(p.tokens)} tokens`}
            >
              <div className="costs-bar-track">
                <div className="costs-bar-fill" style={{ height: `${view.heights[i]}%` }} />
              </div>
              {(days <= 7 || i % 5 === 0 || i === view.series.length - 1) && (
                <small>{p.label}</small>
              )}
            </div>
          ))}
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="costs-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="option--skeleton" />
          ))}
        </div>
      )}

      {empty && !error && (
        <p className="hint">
          {days === 1
            ? t("Nenhuma sessão com uso registrado hoje.")
            : t("Nenhuma sessão com uso registrado nos últimos {days} dias.", { days })}{" "}
          {t("O Yard lê os arquivos que o Claude Code e o Codex gravam em ")}
          <code>~/.claude</code> {t("e")} <code>~/.codex</code>.
        </p>
      )}

      {rows.length > 0 && (
        <>
          {table(t("Por projeto"), view.projects, true)}
          {table(t("Por agente"), view.agents, true)}
          {table(t("Por modelo"), view.models, false)}
        </>
      )}
    </Modal>
  );
}
