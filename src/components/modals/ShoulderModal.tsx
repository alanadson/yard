/**
 * "Ombro" (Shoulder) — what each agent of the group did, read from the
 * sessions on disk, in one sheet.
 *
 * "Ao Vivo" follows one agent as it works; this is the glance over the
 * shoulder at all of them after the fact: last words, files touched, plan
 * progress, cost — and the two doors out, the overlay and the transcript.
 * The reading is the store's (`shoulderStore`); the sentence is
 * `lib/shoulder.ts`; this file only lays them out.
 */
import { useEffect } from "react";
import "./shoulder.css";
import { Activity, AlertTriangle, Bot, FileText, RefreshCw } from "lucide-react";

import { Modal } from "./Modal";
import { BrandIcon } from "../BrandIcon";
import { useT } from "../../hooks/useT";
import { brandById } from "../../lib/brands";
import { since } from "../../lib/format";
import { tn } from "../../lib/i18n";
import { digestLine } from "../../lib/shoulder";
import { transcriptTitle } from "../../lib/transcript";
import { useLive } from "../../stores/liveStore";
import { useProjects } from "../../stores/projectsStore";
import { useShoulder, type ShoulderRow } from "../../stores/shoulderStore";
import { useUI } from "../../stores/uiStore";

interface Payload {
  groupId?: string;
}

/** How many files a row lists before "e mais N". */
const FILES_SHOWN = 5;

export function ShoulderModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const openModal = useUI((s) => s.openModal);
  const payload = useUI((s) => s.modalPayload) as Payload | null;
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const groups = useProjects((s) => s.groups);
  const groupId = payload?.groupId ?? activeGroupId ?? "";
  const group = groups.find((g) => g.id === groupId);

  const rows = useShoulder((s) => s.rows);
  const loading = useShoulder((s) => s.loading);
  const refresh = useShoulder((s) => s.refresh);

  useEffect(() => {
    if (groupId) void useShoulder.getState().load(groupId);
    return () => useShoulder.getState().clear();
  }, [groupId]);

  const openLive = (row: ShoulderRow) => {
    const term = useProjects.getState().terminal(row.terminalId);
    if (!term) return;
    closeModal();
    void useLive
      .getState()
      .openFor(term)
      .catch((e) =>
        useUI.getState().showToast(t("Não consegui abrir o Ao Vivo: {e}", { e: String(e) }), "error"),
      );
  };

  const openTranscript = (row: ShoulderRow) => {
    if (!row.session) return;
    openModal("transcript", {
      file: row.session.file,
      title: `${row.title} — ${transcriptTitle(row.session)}`,
    });
  };

  return (
    <Modal
      title={t("Ombro — {group}", { group: group?.name ?? t("grupo") })}
      onClose={closeModal}
      wide
      headerExtra={
        <button
          className="icon-btn"
          data-tip={t("Ler de novo")}
          aria-label={t("Ler as sessões de novo")}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={loading ? "spin" : undefined} />
        </button>
      }
    >
      <p className="hint">
        {t(
          "O que cada agente deste grupo fez, lido da sessão que a CLI guarda em disco — para quem não estava olhando.",
        )}
      </p>

      {rows.length === 0 && (
        <p className="hint">{t("Nenhuma CLI de agente neste grupo.")}</p>
      )}

      <div className="session-list">
        {rows.map((row) => (
          <Row key={row.terminalId} row={row} onLive={openLive} onTranscript={openTranscript} />
        ))}
      </div>
    </Modal>
  );
}

function Row({
  row,
  onLive,
  onTranscript,
}: {
  row: ShoulderRow;
  onLive: (row: ShoulderRow) => void;
  onTranscript: (row: ShoulderRow) => void;
}) {
  const t = useT();
  const brand = row.agentId ? brandById(row.agentId) : undefined;
  const d = row.digest;
  const now = Date.now();
  return (
    <div className="session shoulder-row">
      <div className="session-main">
        <strong>
          {brand ? <BrandIcon brand={brand} size={13} /> : <Bot size={13} />} {row.title}
        </strong>
        {row.state === "loading" && <small>{t("lendo a sessão…")}</small>}
        {row.state === "unsupported" && (
          <small>{t("esta CLI não guarda a sessão em disco — nada para ler aqui")}</small>
        )}
        {row.state === "none" && <small>{t("sem sessão em disco nesta pasta ainda")}</small>}
        {row.state === "error" && (
          <small className="shoulder-error">
            <AlertTriangle size={11} />{" "}
            {t("não consegui ler a sessão: {error}", { error: row.error ?? "" })}
          </small>
        )}
        {row.state === "ready" && d && (
          <>
            <small className="shoulder-line">{digestLine(d)}</small>
            <div className="shoulder-chips">
              {d.lastAt > 0 && (
                <span className="shoulder-chip" data-tip={t("Último evento da sessão")}>
                  {t("há {ago}", { ago: since(Math.floor(d.lastAt / 1000), now) })}
                </span>
              )}
              {d.commands > 0 && (
                <span className="shoulder-chip">
                  {tn(d.commands, "{n} comando", "{n} comandos")}
                </span>
              )}
              {d.agents > 0 && (
                <span className="shoulder-chip">
                  {tn(d.agents, "{n} sub-agente", "{n} sub-agentes")}
                </span>
              )}
              {d.failures > 0 && (
                <span className="shoulder-chip shoulder-chip--warn">
                  {tn(d.failures, "{n} falha", "{n} falhas")}
                </span>
              )}
              {d.plan && (
                <span className="shoulder-chip" data-tip={t("Plano: concluídas de total")}>
                  {t("plano {done}/{total}", { done: d.plan.done, total: d.plan.total })}
                </span>
              )}
              {d.usage?.costUsd != null && (
                <span className="shoulder-chip" data-tip={t("Estimativa com preços de tabela")}>
                  ~US$ {d.usage.costUsd.toFixed(2)}
                </span>
              )}
            </div>
            {d.files.length > 0 && (
              <ul className="shoulder-files">
                {d.files.slice(0, FILES_SHOWN).map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <span className="shoulder-touches">
                      {f.edits > 0 && t("{n}× editado ", { n: f.edits })}
                      {f.writes > 0 && t("{n}× escrito ", { n: f.writes })}
                      {f.reads > 0 && t("{n}× lido", { n: f.reads })}
                    </span>
                  </li>
                ))}
                {d.files.length > FILES_SHOWN && (
                  <li className="shoulder-more">
                    {t("e mais {n}", { n: d.files.length - FILES_SHOWN })}
                  </li>
                )}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="session-actions">
        {row.state !== "unsupported" && (
          <button className="btn" onClick={() => onLive(row)}>
            <Activity size={12} /> {t("Ao Vivo")}
          </button>
        )}
        {row.state === "ready" && (
          <button className="btn btn--primary" onClick={() => onTranscript(row)}>
            <FileText size={12} /> {t("Transcrição")}
          </button>
        )}
      </div>
    </div>
  );
}
