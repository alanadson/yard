/** Process loss must require reviewed resumption of the current stage while preserving earlier evidence. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseRecovery(page, directory, assertAlive, timeoutMs) {
  await until(() => page.evaluate(() => !!window.__TAURI_INTERNALS__));
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const owner = join(directory, "owner.ps1");
  const replacement = join(directory, "replacement.ps1");
  const second = join(directory, "second-stage.json");
  const resumed = join(directory, "resumed-stage.json");
  const finish = join(directory, "finish-agent");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const hold = `$deadline = [DateTime]::UtcNow.AddSeconds(90)
while (!(Test-Path -LiteralPath ${quote(finish)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 9 }
  Start-Sleep -Milliseconds 25
}`;
  writeFileSync(owner, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
[Console]::WriteLine('RECOVERY_OWNER_READY')
$first = [Console]::ReadLine()
& $client flow stage --timeout 1 | Out-Null
[Console]::WriteLine('### RESUMO DA ETAPA')
[Console]::WriteLine('Preserved first-stage evidence')
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
$stamp = [Console]::ReadLine()
$brief = & $client flow stage --timeout 1 | Out-String
'{}' | & $client hook prompt --stdin --timeout 1 | Out-Null
@{ code = $LASTEXITCODE; brief = $brief; stamp = $stamp } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(second)} -Encoding UTF8
${hold}
`);
  writeFileSync(replacement, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
[Console]::WriteLine('RECOVERY_REPLACEMENT_READY')
$stamp = [Console]::ReadLine()
$brief = & $client flow stage --timeout 1 | Out-String
@{ code = $LASTEXITCODE; brief = $brief; stamp = $stamp } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(resumed)} -Encoding UTF8
[Console]::WriteLine('### RESUMO DA ETAPA')
[Console]::WriteLine('Reviewed stage finished')
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
${hold}
`);
  async function until(read) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const result = await read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Native recovery condition did not complete before its deadline");
  }
  const groupId = "recovery-group", terminalId = "recovery-agent", flowId = "recovery-pipeline";
  const canvas = { items: [{ id: flowId, type: "flow", name: "Native recovery pipeline", stages: [{ label: "Plan", prompt: "Prepare the request" }, { label: "Verify", prompt: "Verify the preserved evidence" }], x: 0, y: 0, w: 240, h: 200, color: "#ffffff" }, { id: "wire", type: "connection", from: flowId, to: terminalId }] };
  await invoke("write_pref", { key: "onboarding.done", value: "1" });
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev, projects: [], groups: [{ id: groupId, projectId: null, name: "Recovery flows", layoutJson: JSON.stringify({ surface: "canvas", canvas }) }],
    terminals: [{ id: terminalId, groupId, kind: "agent", program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", owner], cwd: directory, title: "Recovery fixture", surface: "canvas", createdAt: 1000 }] } })).accepted);
  async function spawn(script, marker) {
    await invoke("spawn_pty", { opts: { id: terminalId, program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: directory, rows: 24, cols: 80, kind: "agent", title: "Recovery fixture", env: [], keepScrollback: false } });
    let answered = 0;
    await until(async () => {
      const attached = await invoke("attach_pty", { id: terminalId });
      const requests = attached.data.split("\u001b[6n").length - 1;
      while (answered < requests) { await invoke("write_pty", { id: terminalId, data: "\u001b[1;1R" }); answered++; }
      return attached.data.includes(marker);
    });
  }
  await spawn(owner, "RECOVERY_OWNER_READY");
  await invoke("flow_start", { input: { groupId, flowId, terminalId, task: "Original recovery request", typed: false } });
  await until(() => existsSync(second));
  await invoke("kill_pty", { id: terminalId });
  const interrupted = await until(async () => (await invoke("flow_snapshot")).find((run) => run.phase === "interrupted"));
  assert.equal(interrupted.current, 1);
  assert.equal(interrupted.stages[0].status, "done");
  assert(!existsSync(resumed));
  await spawn(replacement, "RECOVERY_REPLACEMENT_READY");
  await page.reload();
  await until(() => page.evaluate(() => !!window.__TAURI_INTERNALS__));
  await page.getByText("Recovery flows", { exact: true }).last().click();
  await page.getByRole("button", { name: "Revisar e retomar", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Revisar e retomar fluxo", exact: true });
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  assert.equal((await invoke("flow_snapshot"))[0].phase, "interrupted");
  assert(!existsSync(resumed));
  await page.getByRole("button", { name: "Revisar e retomar", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Revisar e retomar fluxo", exact: true });
  await dialog.getByRole("button", { name: "Retomar etapa", exact: true }).click();
  const report = await until(() => { try { return JSON.parse(readFileSync(resumed, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } });
  assert.equal(report.code, 0);
  assert(report.stamp.includes("etapa 2/2"));
  assert(report.brief.includes("Preserved first-stage evidence"));
  assert(report.brief.includes("Original recovery request"));
  await until(async () => (await invoke("flow_snapshot"))[0]?.phase === "done");
  const row = page.locator(".cv-flowrun").filter({ hasText: "Native recovery pipeline" });
  await row.getByText("concluído", { exact: true }).waitFor();
  await row.getByRole("button", { name: "Dispensar este resultado", exact: true }).click();
  await until(async () => (await invoke("flow_snapshot")).length === 0);
  await page.reload();
  await until(() => page.evaluate(() => !!window.__TAURI_INTERNALS__));
  assert.equal((await invoke("flow_snapshot")).length, 0);
  writeFileSync(finish, "complete");
  return { processLossRequiresReview: true, declinedResumptionSendsNothing: true, resumesOnlyCurrentStage: true, earlierEvidencePreserved: true, dismissalSurvivesReload: true };
}

export function runNativeFlowRecoveryCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseRecovery, options); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeFlowRecoveryCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
