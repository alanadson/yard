// A terminal label identifies its pinned account even after the default changes.
import { expect, it } from "vitest";
import { accountChoices, accountLoginArgs, automationAccountUsage, terminalAccountLabel } from "./accounts";
import { quotaPeak } from "./automationPause";

it("identifies the original account and distinguishes the system login", () => {
  const accounts = [{ id: "work", provider: "codex", label: "Work", status: "ready" }];
  expect(terminalAccountLabel(accounts, { terminalId: "old", provider: "codex", accountId: "work" })).toBe("Work");
  expect(terminalAccountLabel(accounts, { terminalId: "old", provider: "codex", accountId: null })).toBe("Padrão do sistema");
  expect(terminalAccountLabel(accounts, { terminalId: "old", provider: "codex", accountId: "missing" })).toBe("Conta indisponível");
  expect(terminalAccountLabel(accounts, undefined)).toBeNull();
});

it("translates interface labels while preserving account names entered by the user", () => {
  const accounts = [{ id: "work", provider: "codex", label: "Padrão do sistema", status: "ready" }];
  const translate = (text: string) => `translated:${text}`;
  expect(accountChoices(accounts, "codex", translate).map((choice) => choice.label)).toEqual(["translated:Padrão do sistema", "Padrão do sistema"]);
  expect(terminalAccountLabel(accounts, { terminalId: "old", provider: "codex", accountId: "work" }, translate)).toBe("Padrão do sistema");
  expect(terminalAccountLabel(accounts, { terminalId: "system", provider: "codex", accountId: null }, translate)).toBe("translated:Padrão do sistema");
});

it("keeps watching the quota of a running pinned account after selecting another default", () => {
  const usage = (account: string, usedPercent: number) => ({ id: "codex", name: "Codex", account, plan: null,
    windows: [{ key: "session", usedPercent, windowMinutes: 300, resetsAt: null }], status: "ok" as const, error: null, updatedAt: 1000 });
  const personal = usage("personal", 10);
  const work = usage("work", 95);
  const readings = [{ accountId: "personal", usage: personal }, { accountId: "work", usage: work }];
  const bindings = [{ terminalId: "old", provider: "codex", accountId: "work" }];
  expect(quotaPeak(automationAccountUsage([personal], readings, bindings, new Set(["old"])))).toBe(95);
  expect(quotaPeak(automationAccountUsage([personal], readings, bindings, new Set()))).toBe(10);
});

it("starts each provider's native login without an interactive agent prompt", () => {
  expect(accountLoginArgs("codex")).toEqual(["login"]);
  expect(accountLoginArgs("claude")).toEqual(["auth", "login"]);
  expect(() => accountLoginArgs("other")).toThrow();
});

it("offers only this provider's accounts and disables accounts awaiting authentication", () => {
  expect(accountChoices([
    { id: "codex-ready", provider: "codex", label: "Work", status: "ready" },
    { id: "codex-pending", provider: "codex", label: "Personal", status: "auth_required" },
    { id: "claude-ready", provider: "claude", label: "Other", status: "ready" },
  ], "codex")).toEqual([
    { value: "", label: "Padrão do sistema", disabled: false },
    { value: "codex-ready", label: "Work", disabled: false },
    { value: "codex-pending", label: "Personal", disabled: true },
  ]);
});
