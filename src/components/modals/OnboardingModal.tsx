/**
 * The welcome sheet — the first thing a fresh install sees, once.
 *
 * Three things a newcomer cannot discover alone: which CLIs the app already
 * found on the machine, that everything starts from a project folder, and the
 * six gestures that make the app worth using. The decision to show it lives
 * in `lib/onboarding.ts` / `onboardingStore`; this file only draws, and
 * every way out — Começar, Pular, Esc, the ×, the backdrop — marks it done.
 */
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import "./onboarding.css";

import { Modal } from "./Modal";
import { BrandIcon } from "../BrandIcon";
import { useT } from "../../hooks/useT";
import { brandById } from "../../lib/brands";
import { FIRST_RUN_SHORTCUTS, agentRows } from "../../lib/onboarding";
import { createProject, folderName } from "../../lib/projectCreate";
import { useAgents } from "../../stores/agentsStore";
import { useOnboarding } from "../../stores/onboardingStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export function OnboardingModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const markDone = useOnboarding((s) => s.markDone);
  const agentsById = useAgents((s) => s.byId);
  const agentsLoaded = useAgents((s) => s.loaded);
  // Reopened from the palette on an install that already has projects: the
  // folder step is moot, the sheet is a tour.
  const hasProjects = useProjects((s) => s.projects.length > 0);

  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The catalog is read once at boot, off the critical path; the sheet may
  // come up before it arrives.
  useEffect(() => {
    if (!agentsLoaded) void useAgents.getState().load();
  }, [agentsLoaded]);

  const rows = agentRows(Object.values(agentsById));
  const found = rows.filter((r) => r.found).length;

  const leave = () => {
    markDone();
    closeModal();
  };

  const pick = async () => {
    const chosen = await open({ directory: true, multiple: false });
    if (typeof chosen === "string") {
      setPath(chosen);
      setErr(null);
    }
  };

  const start = async () => {
    if (busy) return;
    if (!path.trim()) {
      if (hasProjects) {
        leave();
        return;
      }
      setErr(t("Escolha uma pasta."));
      return;
    }
    setBusy(true);
    try {
      const result = await createProject({ path });
      if (!result.ok) {
        setErr(result.error);
        return;
      }
      showToast(
        t("Projeto “{name}” adicionado — Ctrl+T abre a primeira CLI.", {
          name: folderName(path.trim()),
        }),
      );
      leave();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Bem-vindo ao Yard")}
      onClose={leave}
      dirty={!!path.trim()}
      initialFocus=".onb-pick"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={leave}>
            {t("Pular")}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || (!path.trim() && !hasProjects)}
            onClick={() => void start()}
          >
            {busy ? t("Adicionando…") : t("Começar")}
          </button>
        </div>
      }
    >
      <p className="onb-lead">
        {t(
          "O Yard roda várias CLIs de agentes lado a lado, cada uma num terminal de verdade. Em todo terminal que ele abre, o comando ",
        )}
        <code>yard</code>
        {t(
          " já está no PATH — é por ele que os agentes conversam entre si, dividem notas e recrutam colegas.",
        )}
      </p>

      <section className="onb-section" aria-labelledby="onb-clis">
        <h4 id="onb-clis">
          {t("CLIs nesta máquina")}
          {agentsLoaded && rows.length > 0 && (
            <span className="onb-count">
              {t("{found} de {total}", { found, total: rows.length })}
            </span>
          )}
        </h4>
        {!agentsLoaded ? (
          <p className="hint onb-hint">{t("Procurando as CLIs instaladas…")}</p>
        ) : (
          <ul className="onb-agents">
            {rows.map((r) => {
              const brand = brandById(r.id);
              return (
                <li
                  key={r.id}
                  className={r.found ? "onb-agent" : "onb-agent onb-agent--missing"}
                >
                  <span className="onb-agent-mark" aria-hidden="true">
                    {brand && <BrandIcon brand={brand} size={14} />}
                  </span>
                  <span className="onb-agent-name">{r.name}</span>
                  <span className="onb-agent-version">
                    {r.found ? (r.version ?? t("instalada")) : t("não encontrada")}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {agentsLoaded && found === 0 && (
          <p className="hint onb-hint">
            {t(
              "Nenhuma CLI encontrada. Instale ao menos uma (Claude Code, Codex, OpenCode…) e o Yard passa a oferecê-la em “Nova aba”; até lá, os shells continuam funcionando.",
            )}
          </p>
        )}
      </section>

      <section className="onb-section" aria-labelledby="onb-projeto">
        <h4 id="onb-projeto">{t("O primeiro projeto")}</h4>
        {hasProjects ? (
          <p className="hint onb-hint">
            {t("Você já tem projetos no workspace — este é só o tour.")}
          </p>
        ) : (
          <>
            <p className="hint onb-hint">
              {t(
                "Tudo começa por uma pasta: as CLIs rodam dentro dela e o Yard acompanha o que elas mexem no disco.",
              )}
            </p>
            <div className="input-row">
              <input
                value={path}
                placeholder="C:\Workspace\meu-projeto" // i18n-ok
                aria-label={t("Pasta do primeiro projeto")}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? "onb-erro" : undefined}
                onChange={(e) => {
                  setPath(e.target.value);
                  setErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void start();
                }}
              />
              <button className="btn onb-pick" onClick={() => void pick()}>
                <FolderOpen size={13} /> {t("Procurar")}
              </button>
            </div>
            {err && (
              <p className="hint hint--error" id="onb-erro" role="alert">
                {err}
              </p>
            )}
          </>
        )}
      </section>

      <section className="onb-section shortcut-group" aria-labelledby="onb-atalhos">
        <h4 id="onb-atalhos">{t("Seis atalhos que valem o dia")}</h4>
        {FIRST_RUN_SHORTCUTS.map(([keys, description]) => (
          <div className="shortcut-row" key={description}>
            <span>{t(description)}</span>
            <span className="shortcut-keys">
              {keys.map((key, i) => (
                <span key={key}>
                  {i > 0 && "+"} <kbd>{t(key)}</kbd>
                </span>
              ))}
            </span>
          </div>
        ))}
        <p className="hint onb-hint">
          {t("A lista completa fica em ")}
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd>.
        </p>
      </section>
    </Modal>
  );
}
