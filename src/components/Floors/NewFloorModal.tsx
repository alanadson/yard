import { useRef, useState } from "react";

import { Modal } from "../modals/Modal";
import { createFloor } from "../../lib/floorCreate";
import { findGroupNamed, floorHookEnv, parseHookLines, type FloorHooks } from "../../lib/floors";
import { runFloorHooks } from "../../lib/floorHooks";
import { useChanges } from "../../stores/changesStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import { useT } from "../../hooks/useT";

export function NewFloorModal() {
  const t = useT();
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as { projectId?: string } | null;

  const projects = useProjects((s) => s.projects);
  const project =
    projects.find((p) => p.id === payload?.projectId) ??
    projects.find((p) => p.id === useProjects.getState().activeProjectId);
  const isRepo = useChanges((s) =>
    project ? (s.gitByProject[project.id]?.isRepo ?? true) : false,
  );

  const [itemName, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [existing, setExisting] = useState(false);
  const [cloneGround, setCloneGround] = useState(true);
  const [noGitChosen, setNoGitChosen] = useState<boolean | null>(null);
  const noGit = noGitChosen ?? !isRepo;
  const [setupTxt, setSetupTxt] = useState("");
  const [runTxt, setRunTxt] = useState("");
  const [teardownTxt, setTeardownTxt] = useState("");
  const [autoSetup, setAutoSetup] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * Field errors under the field, not in a toast: whoever is typing looks at
   * the input, and the notice at the window's foot died unread. Toasts stay
   * for the async failures after submit (hooks, worktree).
   */
  const [err, setError] = useState<{ field: "nome" | "branch"; msg: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);

  if (!project) return null;

  const fail = (theField: "nome" | "branch", msg: string) => {
    setError({ field: theField, msg });
    (theField === "nome" ? nameRef : branchRef).current?.focus();
  };

  const create = async () => {
    const name = itemName.trim();
    if (!name) {
      fail("nome", t("Dê um nome ao andar."));
      return;
    }
    if (existing && !branch.trim()) {
      fail("branch", t("Informe a branch existente."));
      return;
    }
    const duplicates = findGroupNamed(
      useProjects.getState().groupsOf(project.id),
      name,
    );
    if (duplicates) {
      fail(
        "nome",
        t('Já existe um grupo/andar chamado "{name}" neste projeto.', { name: duplicates.name }),
      );
      return;
    }
    setBusy(true);
    try {
      const hooks: FloorHooks = {
        setup: parseHookLines(setupTxt),
        run: parseHookLines(runTxt),
        teardown: parseHookLines(teardownTxt),
        autoSetup,
      };
      const { provision } = await createFloor({
        projectId: project.id,
        name,
        branch: branch.trim() || undefined,
        existingBranch: existing,
        noGit: noGit,
        copyGround: cloneGround,
        hooks,
      });
      if (autoSetup && hooks.setup.length) {
        const r = await runFloorHooks(
          provision.path,
          hooks.setup,
          floorHookEnv({
            floorName: name,
            branch: provision.branch ?? undefined,
            floorPath: provision.path,
            rootPath: project.path,
            projectName: project.name,
          }),
        );
        if (!r.ok) showToast(t("Setup do andar falhou: {detail}", { detail: r.detail }), "error");
      }
      showToast(
        provision.kind === "isolated"
          ? t('Andar "{name}" criado na branch {branch}.', { name, branch: provision.branch ?? "" })
          : t('Andar "{name}" criado sem git — mesmo diretório do chão.', { name }),
      );
      closeModal();
    } catch (e) {
      showToast(t("Não consegui criar o andar: {e}", { e: String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("Criar andar")}
      onClose={closeModal}
      dirty={
        !!itemName.trim() ||
        !!branch.trim() ||
        !!setupTxt.trim() ||
        !!runTxt.trim() ||
        !!teardownTxt.trim()
      }
      footer={
        <div className="modal-foot-row">
          <span className="hint grow">
            {t("O andar vira um")} <code>git worktree</code> {t("em")}{" "}
            <code>.yard\floors\…</code> {t("— o chão continua intocado.")}
          </span>
          <button className="btn" onClick={closeModal}>
            {t("Cancelar")}
          </button>
          <button
            className="btn btn--primary"
            disabled={busy || !itemName.trim()}
            onClick={() => void create()}
          >
            {busy ? t("Criando…") : t("Criar andar")}
          </button>
        </div>
      }
    >
      <div className="form">
        <label>
          {t("Nome")}
          <input
            ref={nameRef}
            value={itemName}
            placeholder={t("ex.: fix-login")}
            aria-invalid={err?.field === "nome" ? true : undefined}
            aria-describedby={err?.field === "nome" ? "novo-andar-erro" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (err?.field === "nome") setError(null);
            }}
          />
        </label>
        {err?.field === "nome" && (
          <p className="hint hint--error" id="novo-andar-erro" role="alert">
            {err.msg}
          </p>
        )}
        {!noGit && (
          <>
            <label>
              Branch {existing ? t("existente") : t("(opcional)")}
              <input
                ref={branchRef}
                value={branch}
                placeholder={
                  existing ? t("nome da branch") : t("padrão: yard/<nome>")
                }
                aria-invalid={err?.field === "branch" ? true : undefined}
                aria-describedby={
                  err?.field === "branch" ? "novo-andar-erro-branch" : undefined
                }
                onChange={(e) => {
                  setBranch(e.target.value);
                  if (err?.field === "branch") setError(null);
                }}
              />
            </label>
            {err?.field === "branch" && (
              <p className="hint hint--error" id="novo-andar-erro-branch" role="alert">
                {err.msg}
              </p>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={existing}
                onChange={(e) => setExisting(e.target.checked)}
              />
              {t("Usar uma branch que já existe (sem criar branch nova)")}
            </label>
          </>
        )}
        <label className="checkbox">
          <input
            type="checkbox"
            checked={cloneGround}
            onChange={(e) => setCloneGround(e.target.checked)}
          />
          {t("Clonar o layout do chão (terminais nascem parados, no cwd do andar)")}
        </label>
        {isRepo && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={noGit}
              onChange={(e) => setNoGitChosen(e.target.checked)}
            />
            {t("Sem git: só um grupo novo, no mesmo diretório do chão")}
          </label>
        )}
        <details className="floors-hooks">
          <summary>{t("Hooks (opcional) — um comando por linha")}</summary>
          <label>
            {t("Setup (na criação)")}
            <textarea
              rows={2}
              value={setupTxt}
              placeholder={t("ex.: npm ci")}
              onChange={(e) => setSetupTxt(e.target.value)}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoSetup}
              onChange={(e) => setAutoSetup(e.target.checked)}
            />
            {t("Rodar o setup automaticamente ao criar")}
          </label>
          <label>
            {t("Run (botão ▶ no overview)")}
            <textarea
              rows={2}
              value={runTxt}
              placeholder={t("ex.: npm run dev")}
              onChange={(e) => setRunTxt(e.target.value)}
            />
          </label>
          <label>
            {t("Teardown (ao encerrar)")}
            <textarea
              rows={2}
              value={teardownTxt}
              placeholder={t("ex.: npm run clean")}
              onChange={(e) => setTeardownTxt(e.target.value)}
            />
          </label>
        </details>
      </div>
    </Modal>
  );
}
