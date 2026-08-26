/**
 * Servidores MCP — every CLI's tool servers in one place.
 *
 * One card per CLI the backend knows how to read (`mcp.rs`), listing the
 * servers of every scope that applies to the project on screen, with add,
 * edit, remove, on/off where the CLI has such a flag, and "copy to another
 * CLI" — the reason a manager exists at all. The CLIs whose format was not
 * verified get one dimmed line saying so instead of a guess. Every rule
 * (validation, order, what a copy changes) lives in `lib/mcp.ts`; this file
 * is markup over the store. The labels that module keeps as tables (scope,
 * transport) are translated here, where they are drawn.
 */
import { useEffect, useMemo, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Pencil, Plus, Power, Trash2 } from "lucide-react";

import { useT } from "../../../hooks/useT";
import { tn } from "../../../lib/i18n";
import {
  copyTo,
  draftOf,
  EMPTY_DRAFT,
  groupByCli,
  MCP_SUPPORTED,
  scopeHint,
  scopeLabel,
  scopesFor,
  transportLabel,
  validateServer,
  type CliGroup,
  type McpDraft,
  type McpRow,
  type McpScope,
} from "../../../lib/mcp";
import { useAgents } from "../../../stores/agentsStore";
import { useMcp } from "../../../stores/mcpStore";
import { useProjects } from "../../../stores/projectsStore";
import { useUI } from "../../../stores/uiStore";
import { Select } from "../../Select";
import { Card, GroupTitle } from "../rows";

interface Editing {
  cli: string;
  scope: McpScope;
  draft: McpDraft;
  /** The row being edited; absent when adding. */
  original: McpRow | null;
}

export function SecMcp() {
  const t = useT();
  const rows = useMcp((s) => s.rows);
  const fileErrors = useMcp((s) => s.fileErrors);
  const loading = useMcp((s) => s.loading);
  const error = useMcp((s) => s.error);
  const load = useMcp((s) => s.load);
  const byId = useAgents((s) => s.byId);
  const activeProjectId = useProjects((s) => s.activeProjectId);
  const projects = useProjects((s) => s.projects);
  const showToast = useUI((s) => s.showToast);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;
  const root = project?.path ?? null;

  useEffect(() => {
    void useAgents.getState().load();
  }, []);
  useEffect(() => {
    void load(root);
  }, [root, load]);

  const agents = useMemo(() => Object.values(byId), [byId]);
  const groups = useMemo(() => groupByCli(rows, agents), [rows, agents]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);

  const startAdd = (cli: string) => {
    setEditing({ cli, scope: "user", draft: { ...EMPTY_DRAFT }, original: null });
  };

  const startEdit = async (row: McpRow) => {
    try {
      const secrets = await useMcp.getState().secrets(row.cli, row.scope, row.name);
      setEditing({
        cli: row.cli,
        scope: row.scope as McpScope,
        draft: draftOf(row, secrets),
        original: row,
      });
    } catch (e) {
      showToast(t("Não consegui ler o servidor: {error}", { error: String(e) }), "error");
    }
  };

  const remove = async (row: McpRow) => {
    const ok = await ask(
      t(
        "Remover o servidor “{name}” da configuração de {cli} ({scope})? O arquivo {file} é reescrito sem ele.",
        {
          name: row.name,
          cli: nameOf(groups, row.cli),
          scope: t(scopeLabel(row.scope)),
          file: row.sourceFile,
        },
      ),
      { title: t("Remover servidor MCP"), kind: "warning" },
    );
    if (!ok) return;
    setBusy(true);
    const done = await useMcp.getState().remove(row.cli, row.scope, row.name);
    setBusy(false);
    if (done) showToast(t("Servidor “{name}” removido.", { name: row.name }));
  };

  const toggle = async (row: McpRow) => {
    const secrets = await useMcp.getState().secrets(row.cli, row.scope, row.name).catch(() => null);
    if (!secrets) {
      showToast(t("Não consegui ler o servidor para ligá-lo/desligá-lo."), "error");
      return;
    }
    setBusy(true);
    const done = await useMcp.getState().save(row.cli, row.scope, {
      name: row.name,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      env: secrets.env,
      headers: secrets.headers,
      enabled: !row.enabled,
    });
    setBusy(false);
    if (done) {
      showToast(
        row.enabled
          ? t("“{name}” desligado.", { name: row.name })
          : t("“{name}” ligado.", { name: row.name }),
      );
    }
  };

  const copy = async (row: McpRow, targetCli: string) => {
    const secrets = await useMcp.getState().secrets(row.cli, row.scope, row.name).catch(() => null);
    if (!secrets) {
      showToast(t("Não consegui ler o servidor para copiá-lo."), "error");
      return;
    }
    const result = copyTo(
      {
        name: row.name,
        transport: row.transport,
        command: row.command,
        args: row.args,
        url: row.url,
        env: secrets.env,
        headers: secrets.headers,
        enabled: true,
      },
      targetCli,
    );
    if (!result.ok) {
      showToast(result.reason, "error");
      return;
    }
    setBusy(true);
    const done = await useMcp.getState().save(targetCli, "user", result.server);
    setBusy(false);
    if (done) {
      const copied = t("“{name}” copiado para {cli} (usuário).", {
        name: row.name,
        cli: nameOf(groups, targetCli),
      });
      showToast(result.note ? `${copied} ${result.note}` : copied);
    }
  };

  const submit = async () => {
    if (!editing) return;
    const v = validateServer(editing.draft);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setBusy(true);
    const done = await useMcp.getState().save(editing.cli, editing.scope, v.server);
    setBusy(false);
    if (done) {
      showToast(
        editing.original
          ? t("“{name}” atualizado.", { name: v.server.name })
          : t("“{name}” adicionado.", { name: v.server.name }),
      );
      setEditing(null);
      setErrors({});
    }
  };

  const [errors, setErrors] = useState<Partial<Record<keyof McpDraft, string>>>({});

  return (
    <>
      {error && (
        <p className="hint hint--error" role="alert">
          {error}
        </p>
      )}
      {fileErrors.map((e) => (
        <p className="hint hint--warn" role="alert" key={e}>
          {t("Não consegui ler {file}", { file: e })}
        </p>
      ))}
      <p className="hint">
        {t(
          "Cada CLI guarda seus servidores MCP num arquivo próprio; aqui eles aparecem juntos e editáveis, e o que não é do Yard no arquivo fica como estava.",
        )}{" "}
        {root ? (
          <>
            {t("Os escopos")} <em>{t("local")}</em> {t("e")} <em>{t("projeto")}</em>{" "}
            {t("são do projeto ativo,")} <code>{root}</code>.
          </>
        ) : (
          <>{t("Sem projeto ativo, só o escopo de usuário aparece.")}</>
        )}
        {loading && ` ${t("Lendo…")}`}
      </p>

      {groups.map((g) => (
        <div key={g.cli}>
          <GroupTitle>
            {g.name}
            {!g.installed && g.supported && " · " + t("não instalada nesta máquina")}
          </GroupTitle>
          <Card>
            {!g.supported ? (
              <div className="set-row">
                <span className="set-row-desc">{t("Esta CLI ainda não é suportada aqui.")}</span>
              </div>
            ) : (
              <>
                {g.rows.length === 0 && (
                  <div className="set-row">
                    <span className="set-row-desc">{t("Nenhum servidor configurado.")}</span>
                  </div>
                )}
                {g.rows.map((row) => (
                  <McpRowView
                    key={`${row.scope}:${row.name}`}
                    row={row}
                    groups={groups}
                    busy={busy}
                    onEdit={() => void startEdit(row)}
                    onRemove={() => void remove(row)}
                    onToggle={() => void toggle(row)}
                    onCopy={(cli) => void copy(row, cli)}
                  />
                ))}
                {editing?.cli === g.cli && (
                  <McpForm
                    editing={editing}
                    errors={errors}
                    hasRoot={!!root}
                    busy={busy}
                    onChange={(next) => {
                      setEditing(next);
                      setErrors({});
                    }}
                    onCancel={() => {
                      setEditing(null);
                      setErrors({});
                    }}
                    onSubmit={() => void submit()}
                  />
                )}
                {editing?.cli !== g.cli && (
                  <div className="set-row set-mcp-foot">
                    <button className="btn" disabled={busy} onClick={() => startAdd(g.cli)}>
                      <Plus size={13} /> {t("Adicionar servidor")}
                    </button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      ))}
    </>
  );
}

function nameOf(groups: CliGroup[], cli: string): string {
  return groups.find((g) => g.cli === cli)?.name ?? cli;
}

function McpRowView({
  row,
  groups,
  busy,
  onEdit,
  onRemove,
  onToggle,
  onCopy,
}: {
  row: McpRow;
  groups: CliGroup[];
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onCopy: (cli: string) => void;
}) {
  const t = useT();
  const targets = MCP_SUPPORTED.filter((c) => c !== row.cli).map((c) => ({
    value: c,
    label: nameOf(groups, c),
  }));
  const secretsCount = row.envKeys.length + row.headerKeys.length;
  const line = row.url ?? [row.command ?? "", ...row.args].join(" ").trim();
  return (
    <div className={`set-row set-mcp-row${row.enabled ? "" : " is-off"}`}>
      <div className="set-row-text">
        <span className="set-row-label">
          {row.name}
          <span className="set-chip">{t(transportLabel(row.transport))}</span>
          <span className="set-chip">{t(scopeLabel(row.scope))}</span>
          {!row.enabled && <span className="set-chip">{t("desligado")}</span>}
        </span>
        <small className="set-row-desc set-mcp-line" title={line}>
          {line || "—"}
        </small>
        <small className="set-row-desc set-mcp-path" title={row.sourceFile}>
          {row.sourceFile}
          {secretsCount > 0 &&
            ` · ${tn(secretsCount, "{n} valor guardado", "{n} valores guardados")} (${[...row.envKeys, ...row.headerKeys].join(", ")})`}
        </small>
      </div>
      <div className="set-actions set-mcp-actions">
        <Select
          className="set-picker set-mcp-copy"
          value=""
          placeholder={t("Copiar para…")}
          tip={t("Grava o mesmo servidor no escopo de usuário da outra CLI")}
          options={targets}
          disabled={busy}
          onChange={(v) => v && onCopy(v)}
        />
        {row.canToggle && (
          <button
            className="btn"
            disabled={busy}
            onClick={onToggle}
            title={row.enabled ? t("Desligar sem apagar") : t("Ligar de novo")}
          >
            <Power size={13} /> {row.enabled ? t("Desligar") : t("Ligar")}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={onEdit}>
          <Pencil size={13} /> {t("Editar")}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={onRemove}
          title={t("Reescreve o arquivo sem este servidor (pede confirmação)")}
        >
          <Trash2 size={13} /> {t("Remover")}
        </button>
      </div>
    </div>
  );
}

function McpForm({
  editing,
  errors,
  hasRoot,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  editing: Editing;
  errors: Partial<Record<keyof McpDraft, string>>;
  hasRoot: boolean;
  busy: boolean;
  onChange: (next: Editing) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const { draft, cli, scope, original } = editing;
  const set = (patch: Partial<McpDraft>) => onChange({ ...editing, draft: { ...draft, ...patch } });
  const remote = draft.transport !== "stdio";
  const transports = [
    { value: "stdio", label: t("stdio — um processo local") },
    { value: "http", label: t("HTTP — um endereço remoto") },
    { value: "sse", label: t("SSE — um endereço remoto (eventos)") },
    ...(draft.transport === "ws" ? [{ value: "ws", label: t("WebSocket (só o Claude Code)") }] : []),
  ];
  const scopes = scopesFor(cli).map((s) => ({
    value: s,
    label: `${t(scopeLabel(s))} — ${t(scopeHint(s))}`,
    disabled: s !== "user" && !hasRoot,
  }));
  const canToggle = cli === "codex" || cli === "opencode";

  return (
    <div className="set-mcp-form">
      <Field label={t("Nome")} error={errors.name}>
        <input
          value={draft.name}
          spellCheck={false}
          disabled={!!original}
          placeholder={t("ex.: context7")}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field label={t("Transporte")}>
        <Select
          className="set-picker"
          value={draft.transport}
          options={transports}
          onChange={(v) => set({ transport: v as McpDraft["transport"] })}
        />
      </Field>
      {remote ? (
        <>
          <Field label={t("Endereço")} error={errors.url}>
            <input
              value={draft.url}
              spellCheck={false}
              placeholder="https://…"
              onChange={(e) => set({ url: e.target.value })}
            />
          </Field>
          <Field
            label={t("Cabeçalhos")}
            desc={t("Um CHAVE=valor por linha (ex.: Authorization=Bearer …)")}
            error={errors.headersText}
          >
            <textarea
              value={draft.headersText}
              spellCheck={false}
              rows={2}
              onChange={(e) => set({ headersText: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label={t("Comando")} error={errors.command}>
            <input
              value={draft.command}
              spellCheck={false}
              placeholder={t("ex.: npx")}
              onChange={(e) => set({ command: e.target.value })}
            />
          </Field>
          <Field label={t("Argumentos")} desc={t("Como numa linha de comando; aspas agrupam")}>
            <input
              value={draft.argsText}
              spellCheck={false}
              placeholder={t("ex.: -y “@upstash/context7-mcp”")}
              onChange={(e) => set({ argsText: e.target.value })}
            />
          </Field>
          <Field
            label={t("Variáveis de ambiente")}
            desc={t("Um CHAVE=valor por linha")}
            error={errors.envText}
          >
            <textarea
              value={draft.envText}
              spellCheck={false}
              rows={2}
              onChange={(e) => set({ envText: e.target.value })}
            />
          </Field>
        </>
      )}
      {!original && scopes.length > 1 && (
        <Field label={t("Escopo")}>
          <Select
            className="set-picker set-mcp-scope"
            value={scope}
            options={scopes}
            onChange={(v) => onChange({ ...editing, scope: v as McpScope })}
          />
        </Field>
      )}
      {canToggle && (
        <Field label={t("Ligado")}>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
        </Field>
      )}
      <div className="set-actions set-mcp-form-actions">
        <button className="btn" disabled={busy} onClick={onCancel}>
          {t("Cancelar")}
        </button>
        <button className="btn btn--primary" disabled={busy} onClick={onSubmit}>
          {original ? t("Salvar") : t("Adicionar")}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  desc,
  error,
  children,
}: {
  label: string;
  desc?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="set-mcp-field">
      <span className="set-row-text">
        <span className="set-row-label">{label}</span>
        {desc && <small className="set-row-desc">{desc}</small>}
        {error && (
          <small className="hint hint--error" role="alert">
            {error}
          </small>
        )}
      </span>
      {children}
    </label>
  );
}
