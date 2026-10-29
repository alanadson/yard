/** Verify account management in the native WebView with isolated, deterministic CLI stand-ins. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

const CLI = `
$provider = $args[0]
$cliArgs = @($args | Select-Object -Skip 1)
if ($cliArgs -contains '--version') { Write-Output 'account-fixture 1.0'; exit 0 }
$accountRoot = if ($provider -eq 'codex') { $env:CODEX_HOME } else { $env:CLAUDE_CONFIG_DIR }
if (-not $accountRoot) { exit 3 }
[IO.Directory]::CreateDirectory($accountRoot) | Out-Null
$command = $cliArgs -join ' '
$marker = Join-Path $accountRoot 'fixture-authenticated'
if ($command -eq 'login status' -or $command -eq 'auth status') { if (Test-Path -LiteralPath $marker) { exit 0 }; exit 1 }
if ($command -eq 'login' -or $command -eq 'auth login') { [IO.File]::WriteAllText($marker, 'owned-authentication-fixture'); Write-Output 'Fixture sign-in completed'; exit 0 }
$report = @{ directory = $accountRoot; terminal = $env:YARD_PTY_ID; openai = $env:OPENAI_API_KEY; anthropic = $env:ANTHROPIC_API_KEY } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $accountRoot 'fixture-launch.json'), $report)
while ($null -ne [Console]::ReadLine()) {}
`;

async function exerciseAccounts(page, directory, assertAlive, timeoutMs, fixture) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const waitFor = async (label, condition) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const value = await condition();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  const initial = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { ...initial, projects: [{ id: "accounts-project", name: "Accounts", path: home, createdAt: 1000 }], groups: [{ id: "accounts-group", projectId: "accounts-project", name: "Accounts", layoutJson: "{}" }], terminals: [] } })).accepted);
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();

  async function settings(provider) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Configurações");
    await page.getByRole("option").filter({ hasText: "Configurações" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Agentes", exact: true }).click();
    await dialog.getByRole("tab", { name: provider === "codex" ? /^Codex/ : /^Claude/ }).click();
    return dialog.locator(".accounts-settings");
  }
  async function row(section, label) { return section.locator(".set-row").filter({ hasText: label }).last(); }
  async function createAndLogin(provider, label) {
    let section = await settings(provider);
    await section.getByRole("textbox", { name: "Nome da conta", exact: true }).fill(label);
    await section.getByRole("button", { name: "Adicionar conta", exact: true }).click();
    await section.getByText(label, { exact: true }).waitFor();
    const account = (await invoke("accounts_snapshot")).accounts.find((account) => account.label === label);
    assert(account);
    await (await row(section, label)).getByRole("button", { name: "Fazer login", exact: true }).click();
    const root = join(directory, "accounts", account.id, `.${provider}`);
    await waitFor("isolated CLI sign-in", () => existsSync(join(root, "fixture-authenticated")));
    section = await settings(provider);
    await (await row(section, label)).getByRole("button", { name: "Verificar login", exact: true }).click();
    await (await row(section, label)).getByText("Login verificado", { exact: true }).waitFor();
    return { ...account, root };
  }
  async function select(provider, label) {
    const section = await settings(provider);
    await section.getByRole("combobox", { name: `Conta para novos terminais locais (${provider})`, exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await waitFor("selected account persisted", async () => {
      const snapshot = await invoke("accounts_snapshot");
      return snapshot.accounts.find((account) => account.id === snapshot.selected[provider])?.label === label;
    });
  }
  const checked = [];
  for (const provider of ["codex", "claude"]) {
    const work = await createAndLogin(provider, `Work ${provider}`);
    const personal = await createAndLogin(provider, `Personal ${provider}`);
    await select(provider, work.label);
    const terminalId = `native-account-${provider}`;
    const program = join(fixture, `${provider}.cmd`);
    const snapshot = await invoke("load_workspace");
    assert((await invoke("save_workspace", { snapshot: { ...snapshot, terminals: [...snapshot.terminals, { id: terminalId, groupId: "accounts-group", title: `Pinned ${provider}`, program, args: [], cwd: home, kind: "agent", agentId: provider, createdAt: 1000, alive: false }] } })).accepted);
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("tab", { name: new RegExp(`^Pinned ${provider}`) }).click();
    await page.locator(".pane-exit-banner").getByRole("button", { name: /^(Retomar|Começar do zero)$/ }).click();
    await waitFor("isolated account process", () => existsSync(join(work.root, "fixture-launch.json")));
    const report = JSON.parse(readFileSync(join(work.root, "fixture-launch.json"), "utf8"));
    assert.equal(resolve(report.directory), resolve(work.root));
    assert.equal(provider === "codex" ? report.openai : report.anthropic, null);
    await select(provider, personal.label);
    await page.keyboard.press("Escape");
    rmSync(join(work.root, "fixture-launch.json"));
    await invoke("restart_pty", { id: terminalId });
    await waitFor("restart retains account", () => existsSync(join(work.root, "fixture-launch.json")));
    const binding = (await invoke("accounts_snapshot")).bindings.find((entry) => entry.terminalId === terminalId);
    assert.equal(binding.accountId, work.id);
    await page.reload();
    await page.locator(".terminal-account").filter({ hasText: work.label }).first().waitFor();
    await assert.rejects(invoke("account_remove", { id: work.id }), /account_in_use/);
    const sessionRoot = join(work.root, provider === "codex" ? "sessions" : "projects", "native");
    mkdirSync(sessionRoot, { recursive: true });
    const session = provider === "codex" ? { type: "session_meta", payload: { id: "native-account-session", cwd: home } } : { type: "user", sessionId: "native-account-session", cwd: home, message: { content: "Account history fixture" } };
    writeFileSync(join(sessionRoot, "native-account-session.jsonl"), `${JSON.stringify(session)}\n`);
    const sessions = await invoke("list_agent_sessions", { agent: provider, projectPath: "" });
    assert(sessions.some((session) => session.accountId === work.id));
    const mcpServer = { name: "account-native", transport: "stdio", command: "node", args: ["owned-fixture.js"], url: null, env: {}, headers: {}, enabled: true };
    await invoke("mcp_save", { cli: provider, scope: "user", projectRoot: null, server: mcpServer, accountId: work.id });
    assert(existsSync(join(work.root, provider === "codex" ? "config.toml" : ".claude.json")));
    assert(!existsSync(join(personal.root, provider === "codex" ? "config.toml" : ".claude.json")));
    rmSync(join(work.root, "fixture-authenticated"));
    const failed = await invoke("account_verify", { id: work.id });
    assert.equal(failed.selected[provider], personal.id);
    assert.equal(failed.accounts.find((account) => account.id === work.id).status, "auth_required");
    await invoke("kill_pty", { id: terminalId });
    checked.push(provider);
  }
  const section = await settings("codex");
  await section.getByRole("textbox", { name: "Nome da conta" }).fill("Temporary account");
  await section.getByRole("button", { name: "Adicionar conta", exact: true }).click();
  const temporary = await waitFor("temporary account", async () => (await invoke("accounts_snapshot")).accounts.find((account) => account.label === "Temporary account"));
  await (await row(section, temporary.label)).getByRole("button", { name: "Remover", exact: true }).click();
  await page.getByRole("dialog", { name: "Remover conta", exact: true }).getByRole("button", { name: "Remover", exact: true }).click();
  await waitFor("account removal", async () => !(await invoke("accounts_snapshot")).accounts.some((account) => account.id === temporary.id));
  assert(!existsSync(join(directory, "accounts", temporary.id)));
  const screenshot = join(tmpdir(), `yard-reviewed-accounts-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  await page.setViewportSize({ width: 900, height: 700 });
  const narrowScreenshot = join(tmpdir(), `yard-reviewed-accounts-narrow-${Date.now()}.png`);
  await page.screenshot({ path: narrowScreenshot });
  assert(await section.locator(".account-actions").evaluateAll((rows) => rows.every((row) => [...row.children].every((child) => child.getBoundingClientRect().right <= row.closest(".set-row").getBoundingClientRect().right))), "account actions stay inside narrow rows");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Uso dos agentes e Energético", exact: true }).click();
  const usage = page.getByRole("dialog", { name: "Uso dos agentes e Energético", exact: true });
  await usage.getByRole("combobox", { name: "Conta para novos terminais locais (codex)", exact: true }).waitFor();
  await usage.getByRole("combobox", { name: "Conta para novos terminais locais (claude)", exact: true }).waitFor();
  await usage.getByText("Work codex", { exact: true }).waitFor();
  await usage.getByText("Work claude", { exact: true }).waitFor();
  const usageScreenshot = join(tmpdir(), `yard-reviewed-account-usage-${Date.now()}.png`);
  await page.screenshot({ path: usageScreenshot });
  assert.deepEqual(errors, []);
  return { providers: checked, nativeLogin: true, pinnedRestart: true, failedLoginPreservesDefault: true, accountHistory: true, isolatedMcp: true, guardedRemoval: true, accountUsagePanel: true, screenshot, narrowScreenshot, usageScreenshot };
}

export async function runNativeAccountsCheck(exe, options = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "yard-account-cli-"));
  const previousPath = process.env.PATH;
  const previousOpenai = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  writeFileSync(join(fixture, "agent.ps1"), CLI);
  for (const provider of ["codex", "claude"]) writeFileSync(join(fixture, `${provider}.cmd`), `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent.ps1" ${provider} %*\r\n`);
  process.env.PATH = `${fixture};${previousPath ?? ""}`;
  process.env.OPENAI_API_KEY = "owned-fixture-key-must-not-leak";
  process.env.ANTHROPIC_API_KEY = "owned-fixture-key-must-not-leak";
  try { return await runNativeAppCheck(exe, (...args) => exerciseAccounts(...args, fixture), options); }
  finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenai;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert(basename(fixture).startsWith("yard-account-cli-"));
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runNativeAccountsCheck(process.argv[2] ?? join("src-tauri", "target", "release", "yard.exe"))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
}
