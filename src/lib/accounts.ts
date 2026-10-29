// Labels describe the saved binding, never the current provider default.
import type { AccountBinding, AgentAccount, ProviderUsage, UsageSnapshot } from "./ipc";

export function automationAccountUsage(providers: readonly ProviderUsage[], readings: NonNullable<UsageSnapshot["accounts"]>, bindings: readonly AccountBinding[], active: ReadonlySet<string>): ProviderUsage[] {
  return [...providers, ...readings.filter((entry) => bindings.some((binding) =>
    active.has(binding.terminalId) && binding.provider === entry.usage.id && binding.accountId === entry.accountId,
  )).map((entry) => entry.usage)];
}

export function accountLoginArgs(provider: string): string[] {
  if (provider === "codex") return ["login"];
  if (provider === "claude") return ["auth", "login"];
  throw new Error("unsupported_account_provider");
}

export function accountChoices(accounts: readonly AgentAccount[], provider: string, translate: (text: string) => string = (text) => text) {
  return [
    { value: "", label: translate("Padrão do sistema"), disabled: false },
    ...accounts.filter((account) => account.provider === provider).map((account) => ({
      value: account.id, label: account.label, disabled: account.status !== "ready",
    })),
  ];
}

export function terminalAccountLabel(accounts: readonly AgentAccount[], binding: AccountBinding | undefined, translate: (text: string) => string = (text) => text): string | null {
  if (!binding) return null;
  if (binding.accountId === null) return translate("Padrão do sistema");
  return accounts.find((account) => account.id === binding.accountId)?.label ?? translate("Conta indisponível");
}
