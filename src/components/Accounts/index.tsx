// Native CLI login owns credentials. These controls handle metadata and terminal identity.
import { useEffect, useState } from "react";
import { nanoid } from "nanoid";
import { Select } from "../Select";
import { Card, GroupTitle, Row } from "../Settings/rows";
import { useT } from "../../hooks/useT";
import { accountChoices, accountLoginArgs, terminalAccountLabel } from "../../lib/accounts";
import { ask } from "../../lib/confirmation";
import { ipc, type AgentAccount } from "../../lib/ipc";
import { startTerminalProcess } from "../../lib/lifecycle";
import { useAccounts } from "../../stores/accountsStore";
import { useAgents } from "../../stores/agentsStore";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";
import "./style.css";

// i18n-scan: table, translated at the point of display.
const ERRORS: Record<string, string> = {
  account_auth_required: "Verifique o login antes de usar esta conta.",
  account_in_use: "Feche os terminais desta conta antes de removê-la.",
  account_directory_unavailable: "O diretório da conta não está disponível. Confira o armazenamento local.",
  account_cli_unavailable: "O CLI não foi encontrado neste computador.",
  account_probe_timeout: "A verificação demorou demais. Tente novamente.",
  account_already_bound: "Este terminal já está vinculado a outra conta.",
  account_not_found: "Conta indisponível",
  account_transport_unsupported: "Esta conta exige o CLI local no Windows. Confira o ambiente do agente.",
};

export function AccountPicker({ provider, disabled = false }: { provider: string; disabled?: boolean }) {
  const t = useT();
  const accounts = useAccounts((state) => state.accounts);
  const selected = useAccounts((state) => state.selected[provider]);
  const name = useAgents((state) => state.byId[provider]?.name ?? provider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <div className="account-picker">
    <small className="account-picker-provider">{name}</small>
    <Select label={t("Conta para novos terminais locais ({provider})", { provider })} value={selected ?? ""}
      options={accountChoices(accounts, provider, t)}
      disabled={disabled || busy} onChange={(value) => {
        setBusy(true); setError(null);
        void ipc.accountSelect(provider, value || null).then(() => useAccounts.getState().load())
          .catch((reason) => setError(t(ERRORS[String(reason)] ?? "Não consegui atualizar a conta. Tente novamente.")))
          .finally(() => setBusy(false));
      }} />
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function TerminalAccountBadge({ id }: { id: string }) {
  const t = useT();
  const binding = useAccounts((state) => state.bindings[id]);
  const accounts = useAccounts((state) => state.accounts);
  const label = terminalAccountLabel(accounts, binding, t);
  return label === null ? null : <span className="terminal-account" title={t("Conta deste terminal: {account}", { account: label })}>{label}</span>;
}

export function AccountsSettings({ provider, local }: { provider: string; local: boolean }) {
  const t = useT();
  const accounts = useAccounts((state) => state.accounts);
  const bin = useAgents((state) => state.byId[provider]?.bin);
  const groupId = useProjects((state) => state.activeGroupId);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void useAccounts.getState().load().catch(() => setError(t("Não consegui atualizar a conta. Tente novamente."))); }, [provider, t]);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await operation(); await useAccounts.getState().load(); }
    catch (reason) { setError(t(ERRORS[String(reason)] ?? "Não consegui atualizar a conta. Tente novamente.")); }
    finally { setBusy(false); }
  };
  const login = async (account: AgentAccount) => {
    if (!groupId || !bin) return;
    const projects = useProjects.getState();
    const group = projects.groups.find((candidate) => candidate.id === groupId);
    const cwd = projects.projects.find((project) => project.id === group?.projectId)?.path ?? ".";
    const args = accountLoginArgs(provider);
    const id = projects.addTerminal({ groupId, program: bin, args, cwd, kind: "shell", title: t("Login: {account}", { account: account.label }) });
    try {
      await ipc.accountAssign(id, provider, account.id);
      await startTerminalProcess(id, { program: bin, args, cwd, kind: "shell", title: t("Login: {account}", { account: account.label }) });
      useUI.getState().closeModal();
    } catch (reason) { projects.removeTerminal(id); throw reason; }
  };
  return <section className="accounts-settings" aria-label={t("Contas do agente")}>
    <GroupTitle>{t("Contas do agente")}</GroupTitle>
    <p className="hint">{t("O padrão vale para novos terminais locais. Terminais existentes mantêm sua conta ao reiniciar ou retomar.")}</p>
    {!local && <p className="hint">{t("As contas do Yard estão disponíveis no Windows local. WSL e SSH usam o login do ambiente de destino.")}</p>}
    <Card>
      <Row label={t("Conta padrão")}><AccountPicker provider={provider} disabled={busy || !local} /></Row>
      {accountChoices(accounts, provider).slice(1).map((choice) => {
        const account = accounts.find((candidate) => candidate.id === choice.value)!;
        return <Row key={account.id} label={account.label} desc={choice.disabled ? t("Login necessário") : t("Login verificado")}>
          <div className="account-actions">
            <button className="btn" disabled={busy || !local || !groupId || !bin} onClick={() => void run(() => login(account))}>{t("Fazer login")}</button>
            <button className="btn" disabled={busy || !local || !bin} onClick={() => void run(() => ipc.accountVerify(account.id))}>{t("Verificar login")}</button>
            <button className="btn" disabled={busy} onClick={() => void run(async () => {
              if (await ask(t("Remover a conta {account} e seus arquivos locais de login e histórico?", { account: account.label }), { title: t("Remover conta"), okLabel: t("Remover") })) await ipc.accountRemove(account.id);
            })}>{t("Remover")}</button>
          </div>
        </Row>;
      })}
      <Row label={t("Nova conta")}>
        <form className="account-actions" onSubmit={(event) => { event.preventDefault(); void run(async () => { await ipc.accountCreate(nanoid(16), provider, label); setLabel(""); }); }}>
          <input className="input" aria-label={t("Nome da conta")} placeholder={t("Pessoal ou trabalho")} value={label} maxLength={80} disabled={busy || !local} onChange={(event) => setLabel(event.target.value)} />
          <button className="btn" disabled={busy || !local || !label.trim()}>{t("Adicionar conta")}</button>
        </form>
      </Row>
    </Card>
    <p className="hint">{t("Após concluir o login no terminal, volte aqui e clique em Verificar login. A seleção do padrão é manual.")}</p>
    {!groupId && <p className="hint">{t("Abra um projeto ou quadro para iniciar o login em um terminal.")}</p>}
    {error && <p role="alert" className="hint">{error}</p>}
  </section>;
}
