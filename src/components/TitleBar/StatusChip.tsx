/**
 * Agent usage + Energético (keep-awake), in a single title-bar chip.
 *
 * The right side of the bar held eight simultaneous controls, two of them
 * (usage and keep-awake) read far more often than they are clicked — so they
 * share one chip and one popover: the usage blocks on top, the Energético
 * radio group below. Below 1180px the meters leave the strip but the chip
 * stays: the popover keeps every reading, where before the whole meter
 * simply vanished.
 *
 * The strip shows one chip per connected agent (name + meter + percentage of
 * the most consumed window); the popover has every window (Session, Week,
 * Fable, Month), reset time and account status. Data arrives live over
 * `usage://update`; the reset clocks re-render only the text, via `useNow`.
 *
 * Renders into the body portal like ContextMenu: the title bar has its own
 * blur/overflow and an internal `position: absolute` would be clipped. A body
 * portal also sits at the end of the Tab order — so opening moves focus into
 * the popover, and Esc gives it back to the chip.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, Gauge, Moon, RefreshCw, Zap } from "lucide-react";

import { BrandIcon } from "../BrandIcon";
import { brandById } from "../../lib/brands";
// i18n-scan: tables
import { ago, untilShort } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { ProviderUsage, UsageWindow } from "../../lib/ipc";
import { usePower, type PowerMode } from "../../stores/powerStore";
import { useUI } from "../../stores/uiStore";
import { useUsage, worstWindow } from "../../stores/usageStore";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../hooks/useT";
import { buildUsageStrip } from "./usageStrip";

/** Same steps as the memory HUD: blue → yellow (warning) → red. */
function meterClass(pct: number): string {
  if (pct >= 90) return "usage-meter-fill usage-meter-fill--crit";
  if (pct >= 75) return "usage-meter-fill usage-meter-fill--warn";
  return "usage-meter-fill";
}

function windowLabel(w: UsageWindow): string {
  switch (w.key) {
    case "session":
      return t("Sessão");
    case "weekly":
      return t("Semana");
    case "monthly":
      return t("Mês");
    default:
      // Per-model window ("fable" today): the name comes from the API, capitalized.
      return w.key.charAt(0).toUpperCase() + w.key.slice(1);
  }
}

const POWER_MODES: {
  id: PowerMode;
  icon: typeof Zap;
  label: string;
  desc: string;
}[] = [
  {
    id: "always",
    icon: Zap,
    label: "Sempre acordado",
    desc: "O PC não suspende nem apaga a tela enquanto o Yard estiver aberto.",
  },
  {
    id: "agents",
    icon: Bot,
    label: "Só com agente rodando",
    desc: "Acordado apenas enquanto um agente (Claude, Codex, qualquer CLI) estiver trabalhando.",
  },
  {
    id: "off",
    icon: Moon,
    label: "Desligado",
    desc: "O Windows segue as configurações de energia de sempre.",
  },
];

/**
 * The energy drink, drawn here — Lucide has no can, and the control is called
 * Energético.
 *
 * The first attempt at one was rejected for reading as a battery at chrome
 * size, and it deserved to be: it was a plain rounded body with a bolt inside,
 * and the bolt is exactly the part that dissolves below ~16px. What carries a
 * can instead is the silhouette — a lid narrower than the body, the seam right
 * under the shoulder, nothing else. Checked at 13 and 14 real pixels, not at a
 * scaled-up preview, which is what hid the problem the first time.
 */
function EnergyCan({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3h6l2 3.5V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6.5L9 3Z" />
      <path d="M7 6.5h10" />
    </svg>
  );
}

function Meter({ pct }: { pct: number }) {
  return (
    <span className="usage-meter" aria-hidden="true">
      <span className={meterClass(pct)} style={{ transform: `scaleX(${pct / 100})` }} />
    </span>
  );
}

function ResetIn({ at }: { at: number | null }) {
  const t = useT();
  const now = useNow(30_000);
  if (at === null) return null;
  const left = at - now;
  return (
    <span className="usage-reset">
      {left <= 0 ? t("reiniciando…") : untilShort(left)}
    </span>
  );
}

/**
 * The provider's mark. It matters most in the strip: below 1360px the name is
 * hidden to make room, and without it a meter belonged to nobody.
 */
function ProviderMark({ id, size }: { id: string; size: number }) {
  const brand = brandById(id);
  return brand ? <BrandIcon brand={brand} size={size} /> : null;
}

function ProviderBlock({ p }: { p: ProviderUsage }) {
  const t = useT();
  const now = useNow(30_000);
  const note = (() => {
    if (p.status === "ok") return null;
    if (p.status === "stale" && p.updatedAt > 0) {
      return {
        text: t("Sem resposta agora — dados de {ago} atrás", { ago: ago(now - p.updatedAt) }),
        tone: "dim",
      };
    }
    return { text: p.error ?? t("Indisponível"), tone: p.status === "missing" ? "dim" : "bad" };
  })();

  return (
    <section className="usage-prov" aria-label={t("Uso de {name}", { name: p.name })}>
      <div className="usage-prov-head">
        <ProviderMark id={p.id} size={12} />
        <span className="usage-prov-name">{p.name}</span>
        {p.plan && <span className="usage-plan">{p.plan}</span>}
        {p.account && <span className="usage-account">{p.account}</span>}
      </div>
      {/* The index belongs in the key: `w.key` is the one identifier in the
          app that comes from a provider's response (the per-model window is
          named after the model), so it is the one that cannot be assumed
          unique. The backend dedupes too; this is the belt. */}
      {p.windows.map((w, i) => (
        <div className="usage-row" key={`${w.key}:${i}`}>
          <span className="usage-row-label">{windowLabel(w)}</span>
          <Meter pct={w.usedPercent} />
          <span className="usage-row-pct">{Math.round(w.usedPercent)}%</span>
          <ResetIn at={w.resetsAt} />
        </div>
      ))}
      {note && (
        <p className={`usage-note ${note.tone === "bad" ? "usage-note--bad" : ""}`}>
          {note.text}
        </p>
      )}
    </section>
  );
}

function UpdatedAgo({ at }: { at: number }) {
  const now = useNow(10_000);
  if (!at) return null;
  return <span className="usage-updated">{ago(now - at)}</span>;
}

export function StatusChip() {
  const t = useT();
  const providers = useUsage((s) => s.providers);
  const fetchedAt = useUsage((s) => s.fetchedAt);
  const nudge = useUsage((s) => s.nudge);
  const mode = usePower((s) => s.mode);
  const engaged = usePower((s) => s.engaged);
  const setMode = usePower((s) => s.setMode);
  const meter = useUI((s) => s.prefs.usageWidget);
  const [open, setOpen] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // With the meter off the chip is just the Energético can; the popover
  // keeps every reading for whoever opens it (`usageStrip.ts`).
  const { chips, emptyGauge } = buildUsageStrip(providers, meter);

  useLayoutEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  // The portal lives at the end of the body: without this, Tab after opening
  // went to the next title-bar control and never reached the popover.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  // Closes on outside click and Esc — the two paths a popover honors.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const refresh = () => {
    nudge();
    setSpinning(true);
    window.setTimeout(() => setSpinning(false), 1200);
  };

  const powerStatus =
    mode === "off"
      ? t("O PC dorme normalmente.")
      : mode === "always"
        ? t("Segurando o PC acordado agora.")
        : engaged
          ? t("Agente trabalhando — segurando o PC acordado.")
          : t("Nenhum agente trabalhando — o PC pode dormir.");

  // Arrows walk the three modes, as `role="radio"` promises.
  const onRadioKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    const radios = [
      ...(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]') ?? []),
    ];
    const idx = radios.indexOf(document.activeElement as HTMLElement);
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    radios[(idx + delta + radios.length) % radios.length]?.focus();
  };

  return (
    <>
      <button
        ref={btnRef}
        className="usage-strip"
        data-tip={t("Uso dos agentes e Energético")}
        aria-label={t("Uso dos agentes e Energético")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {emptyGauge ? (
          <Gauge size={14} aria-hidden="true" />
        ) : (
          chips.map((p) => {
            const worst = worstWindow(p);
            if (!worst) return null;
            const degraded = p.status !== "ok";
            return (
              <span className="usage-chip" key={p.id}>
                {degraded && (
                  <span
                    className={`usage-chip-dot ${
                      p.status === "stale" || p.status === "auth"
                        ? "usage-chip-dot--warn"
                        : "usage-chip-dot--crit"
                    }`}
                    aria-hidden="true"
                  />
                )}
                <ProviderMark id={p.id} size={12} />
                <span className="usage-chip-name">{p.name}</span>
                <Meter pct={worst.usedPercent} />
                <span className={`usage-chip-pct ${degraded ? "is-stale" : ""}`}>
                  {Math.round(worst.usedPercent)}%
                </span>
              </span>
            );
          })
        )}
        <span
          className={`usage-strip-energy ${mode !== "off" ? "is-active" : ""}`}
          aria-hidden="true"
        >
          <EnergyCan size={14} />
          {engaged && <span className="energy-dot" />}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="usage-pop"
            role="dialog"
            aria-label={t("Uso dos agentes e Energético")}
            style={{ top: pos.top, right: pos.right }}
          >
            <div className="usage-pop-head">
              <span className="usage-pop-title">{t("Uso dos agentes")}</span>
              <UpdatedAgo at={fetchedAt} />
              <button
                className={`icon-btn usage-refresh ${spinning ? "is-spinning" : ""}`}
                data-tip={t("Atualizar agora")}
                data-tip-at="right"
                aria-label={t("Atualizar agora")}
                onClick={refresh}
              >
                <RefreshCw size={12} />
              </button>
            </div>
            {providers.length === 0 ? (
              <p className="usage-note">
                {t("Nenhuma CLI com medidor de uso detectada ainda.")}
              </p>
            ) : (
              providers.map((p) => <ProviderBlock p={p} key={p.id} />)
            )}
            <div
              className="energy-sect"
              role="radiogroup"
              aria-label={t("Energético")}
              onKeyDown={onRadioKey}
            >
              <div className="energy-pop-title">{t("Energético")}</div>
              {POWER_MODES.map((o) => (
                <button
                  key={o.id}
                  className="energy-opt"
                  role="radio"
                  aria-checked={mode === o.id}
                  onClick={() => setMode(o.id)}
                >
                  <o.icon size={14} className="energy-opt-icon" aria-hidden="true" />
                  <span className="energy-opt-text">
                    <span className="energy-opt-label">{t(o.label)}</span>
                    <span className="energy-opt-desc">{t(o.desc)}</span>
                  </span>
                  {mode === o.id && (
                    <Check size={13} className="energy-opt-check" aria-hidden="true" />
                  )}
                </button>
              ))}
              <p className="energy-status" role="status">
                {powerStatus}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
