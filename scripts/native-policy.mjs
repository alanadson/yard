/** Verify scheduling limits with real agents while the application page is unloaded. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exercisePolicy(page, directory, assertAlive, timeoutMs) {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const root = join(directory, "shared-working-directory");
  mkdirSync(root);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const finish = join(directory, "finish-policy-agents");
  const receipt = (id, pass) => join(directory, `receipt-${id}-${pass}.json`);
  const release = (id, pass) => join(directory, `release-${id}-${pass}`);
  const report = join(directory, "managed-resource-report.json");
  const submitted = join(directory, "managed-resource-submission.json");
  writeFileSync(report, JSON.stringify({ delivery: { summary: "Managed resource check finished", artifacts: [], checks: [] }, evidence: {} }));
  const agents = [];
  async function until(read) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Native policy condition did not complete before its deadline");
  }
  for (const id of ["policy-one", "policy-two"]) {
    const script = join(directory, `${id}.ps1`);
    writeFileSync(script, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
[Console]::WriteLine('POLICY_READY')
foreach ($pass in @(1, 2, 3)) {
  $body = [Console]::ReadLine()
  '{}' | & $client hook prompt --stdin --timeout 1 | Out-Null
  if ($pass -eq 3) { '{}' | & $client hook stop --stdin --timeout 1 | Out-Null }
  @{ body = $body } | ConvertTo-Json -Compress | Set-Content -LiteralPath (${quote(join(directory, `receipt-${id}-`))} + $pass + '.json') -Encoding UTF8
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path -LiteralPath (${quote(join(directory, `release-${id}-`))} + $pass))) {
    if ([DateTime]::UtcNow -gt $deadline) { exit 8 }
    Start-Sleep -Milliseconds 25
  }
  if ($pass -eq 3 -and ${quote(id)} -eq 'policy-one') {
    $output = & $client task submit managed-resource --attempt managed-resource-attempt --file ${quote(report)} --timeout 1 | Out-String
    @{ code = $LASTEXITCODE; output = $output } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(submitted)} -Encoding UTF8
  }
  '{}' | & $client hook stop --stdin --timeout 1 | Out-Null
}
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath ${quote(finish)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 8 }
  Start-Sleep -Milliseconds 25
}
`);
    await invoke("spawn_pty", { opts: { id, program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: root,
      rows: 24, cols: 80, kind: "agent", title: id, env: [], keepScrollback: false } });
    agents.push({ id, script });
    let answered = 0;
    await until(async () => {
      const attached = await invoke("attach_pty", { id });
      const requests = attached.data.split("\u001b[6n").length - 1;
      while (answered < requests) { await invoke("write_pty", { id, data: "\u001b[1;1R" }); answered++; }
      return attached.data.includes("POLICY_READY");
    });
  }
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "policy-project", name: "Policy verification", path: root, createdAt: 1000 }],
    groups: [{ id: "policy-group", projectId: "policy-project", name: "Policy verification", layoutJson: "{}" }],
    terminals: agents.map(({ id, script }) => ({ id, groupId: "policy-group", title: id, kind: "agent", program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: root, createdAt: 1000 })),
  } })).accepted);
  const readReceipt = async (id, pass) => until(() => {
    try { return JSON.parse(readFileSync(receipt(id, pass), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  for (const pass of [1, 2]) {
    await invoke("write_pref", { key: "automationMaxAgents", value: String(pass) });
    await invoke("write_pref", { key: "automationLockDirectories", value: pass === 2 ? "true" : "false" });
    await until(async () => (await invoke("queue_read")).length === 0);
    const items = ["policy-one", "policy-two"].map((terminalId) => ({ id: `${terminalId}-${pass}`, terminalId, text: `Policy request ${pass}`, at: 1000, source: "bridge" }));
    await invoke("queue_patch", { before: [], after: items });
    await page.goto("about:blank");
    assert.equal((await readReceipt("policy-one", pass)).body, `Policy request ${pass}`);
    const firstObservedAt = Date.now();
    await until(() => Date.now() - firstObservedAt >= 6000);
    assert(!existsSync(receipt("policy-two", pass)), pass === 1
      ? "A second agent started while the configured global limit was occupied"
      : "A second agent started in a working directory reserved by an active agent");
    writeFileSync(release("policy-one", pass), "reviewed release");
    assert.equal((await readReceipt("policy-two", pass)).body, `Policy request ${pass}`);
    writeFileSync(release("policy-two", pass), "reviewed release");
    await page.goto("http://tauri.localhost");
    await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
    await until(async () => {
      const hooks = await invoke("native_hook_snapshot");
      return ["policy-one", "policy-two"].every((id) => hooks.some((report) => report.terminalId === id && report.event.kind === "turn-end"));
    });
  }
  assert.deepEqual(await invoke("queue_read"), []);
  await invoke("write_pref", { key: "automationMaxAgents", value: "1" });
  await invoke("write_pref", { key: "automationLockDirectories", value: "false" });
  const managed = await invoke("task_create", { input: { id: "managed-resource", title: "Managed execution slot", request: "Retain the slot until an accepted report", criteria: [] } });
  const managedQueue = await invoke("task_enqueue", { id: managed.id, revision: managed.revision, terminalId: "policy-one", queueId: "managed-resource-attempt" });
  const waitingPeer = { id: "peer-after-managed-work", terminalId: "policy-two", text: "Peer waits for the managed report", at: 1000, source: "bridge" };
  await invoke("queue_patch", { before: managedQueue.items, after: [...managedQueue.items, waitingPeer] });
  await page.goto("about:blank");
  await readReceipt("policy-one", 3);
  const managedObservedAt = Date.now();
  await until(() => Date.now() - managedObservedAt >= 8000);
  assert(!existsSync(receipt("policy-two", 3)), "A quiet but unreported managed execution must retain its global slot");
  writeFileSync(release("policy-one", 3), "complete the managed execution");
  const submission = await until(() => {
    try { return JSON.parse(readFileSync(submitted, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(submission.code, 0);
  assert.equal(JSON.parse(submission.output).status, "in_review");
  assert.equal((await readReceipt("policy-two", 3)).body, waitingPeer.text);
  writeFileSync(release("policy-two", 3), "complete the peer execution");
  await page.goto("http://tauri.localhost");
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await until(async () => (await invoke("queue_read")).length === 0);
  await invoke("write_pref", { key: "automationMaxAgents", value: "2" });
  await invoke("write_pref", { key: "automationLockDirectories", value: "true" });
  const uncertain = { id: "policy-uncertain", terminalId: "policy-one", text: "Unconfirmed earlier request", at: 1000, source: "bridge",
    delivery: { status: "uncertain", attemptedAt: 1000, owner: "native" } };
  const peer = { id: "policy-peer-after-uncertainty", terminalId: "policy-two", text: "Wait for reviewed resource release", at: 1000, source: "bridge" };
  await invoke("queue_patch", { before: [], after: [uncertain, peer] });
  await page.goto("about:blank");
  const uncertaintyObservedAt = Date.now();
  await until(() => Date.now() - uncertaintyObservedAt >= 8000);
  await page.goto("http://tauri.localhost");
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  assert.deepEqual((await invoke("queue_read")).map((item) => item.id), [uncertain.id, peer.id], "Uncertain delivery must retain its directory reservation before review");
  await invoke("queue_remove", { id: uncertain.id, attemptedAt: 1000 });
  await until(async () => (await invoke("queue_read")).length === 0);
  writeFileSync(finish, "complete");
  const welcomeSkip = page.getByRole("button", { name: "Pular", exact: true });
  if (await welcomeSkip.isVisible()) await welcomeSkip.click();
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Configurações");
  await page.getByRole("option").filter({ hasText: "Configurações" }).first().click();
  const settings = page.getByRole("dialog", { name: "Configurações", exact: true });
  await settings.getByRole("button", { name: "Comportamento", exact: true }).click();
  const limit = settings.getByLabel("Máximo de agentes ativos", { exact: true });
  assert.equal(await limit.inputValue(), "2");
  const protection = settings.getByRole("switch", { name: "Um agente por pasta durante a execução automática", exact: true });
  assert(await protection.isChecked());
  await limit.fill("3");
  await limit.press("Tab");
  await protection.click();
  await until(async () => {
    const preferences = await invoke("read_prefs");
    return preferences.automationMaxAgents === "3" && preferences.automationLockDirectories === "false";
  });
  const screenshot = join(tmpdir(), `yard-native-policy-settings-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  return { nativeGlobalAgentLimit: true, globalLimitReleasesOnCompletion: true, nativeDirectoryLock: true, directoryLockReleasesOnCompletion: true, managedExecutionHoldsSlotUntilReport: true, uncertainDirectoryRequiresReview: true, policyControlsPersistFromUi: true, screenshot };
}

export function runNativePolicyCheck(exe, options = {}) { return runNativeAppCheck(exe, exercisePolicy, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativePolicyCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
