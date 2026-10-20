/** The existing flow CLI retains its execution slot until the native pipeline has finished. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseLegacyFlow(page, directory, assertAlive, timeoutMs) {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const trigger = join(directory, "start-legacy-flow");
  const finish = join(directory, "finish-legacy-agents");
  const started = join(directory, "legacy-start.json");
  const completed = join(directory, "legacy-stages-completed");
  const peerReceipt = join(directory, "legacy-peer-receipt.json");
  const heldStage = join(directory, "held-native-stage");
  const releaseStage = join(directory, "release-native-stage");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const ownerScript = join(directory, "legacy-owner.ps1");
  const peerScript = join(directory, "legacy-peer.ps1");
  const waitFinish = `$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath ${quote(finish)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 8 }
  Start-Sleep -Milliseconds 25
}
`;
  writeFileSync(ownerScript, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
[Console]::WriteLine('LEGACY_OWNER_READY')
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath ${quote(trigger)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 8 }
  Start-Sleep -Milliseconds 25
}
$output = & $client flow run 'Legacy pipeline' 'Original legacy request' --timeout 1 | Out-String
@{ code = $LASTEXITCODE; output = $output } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(started)} -Encoding UTF8
foreach ($stage in @(1, 2)) {
  $stamp = [Console]::ReadLine()
  '{}' | & $client hook prompt --stdin --timeout 1 | Out-Null
  if ($stage -eq 1) {
    Set-Content -LiteralPath ${quote(heldStage)} -Value 'working'
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (!(Test-Path -LiteralPath ${quote(releaseStage)})) {
      if ([DateTime]::UtcNow -gt $deadline) { exit 8 }
      Start-Sleep -Milliseconds 25
    }
  }
  $brief = & $client flow stage --timeout 1 | Out-String
  [Console]::WriteLine($brief)
  [Console]::WriteLine('### RESUMO DA ETAPA')
  [Console]::WriteLine('Owned legacy stage completed')
  if ($stage -eq 2) { Set-Content -LiteralPath ${quote(completed)} -Value 'complete' }
  '{}' | & $client hook stop --stdin --timeout 1 | Out-Null
}
${waitFinish}`);
  writeFileSync(peerScript, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
[Console]::WriteLine('LEGACY_PEER_READY')
$body = [Console]::ReadLine()
$task = & $client task show legacy-peer-task --timeout 1 | Out-String
@{ code = $LASTEXITCODE; task = $task } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(peerReceipt)} -Encoding UTF8
${waitFinish}`);
  async function until(read) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const result = await read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Legacy flow condition did not complete before its deadline");
  }
  const actors = [{ id: "legacy-owner", title: "Legacy owner", script: ownerScript }, { id: "legacy-peer", title: "Legacy peer", script: peerScript }];
  for (const actor of actors) {
    await invoke("spawn_pty", { opts: { id: actor.id, program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", actor.script], cwd: directory,
      rows: 24, cols: 80, kind: "agent", title: actor.title, env: [], keepScrollback: false } });
    let answered = 0;
    await until(async () => {
      const attached = await invoke("attach_pty", { id: actor.id });
      const requests = attached.data.split("\u001b[6n").length - 1;
      while (answered < requests) { await invoke("write_pty", { id: actor.id, data: "\u001b[1;1R" }); answered++; }
      return attached.data.includes(actor.id === "legacy-owner" ? "LEGACY_OWNER_READY" : "LEGACY_PEER_READY");
    });
  }
  const workspace = await invoke("load_workspace");
  const layout = { surface: "canvas", canvas: { viewport: { x: 0, y: 0, zoom: 1 }, nodes: {
    "legacy-owner": { x: 20, y: 350, w: 420, h: 280 }, "legacy-peer": { x: 470, y: 350, w: 420, h: 280 },
  }, items: [
    { id: "legacy-pipeline", type: "flow", name: "Legacy pipeline", trigger: false, x: 100, y: 100, w: 300, h: 220, stages: [{ label: "First", prompt: "Perform the first requested stage." }, { label: "Second", prompt: "Complete the requested verification." }] },
    { id: "legacy-wire", type: "connection", from: "legacy-pipeline", to: "legacy-owner" },
  ] } };
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev, projects: [{ id: "legacy-project", name: "Legacy verification", path: directory, createdAt: 1000 }],
    groups: [{ id: "legacy-group", projectId: null, name: "Legacy verification", layoutJson: JSON.stringify(layout) }],
    terminals: actors.map((actor, slot) => ({ id: actor.id, title: actor.title, groupId: "legacy-group", kind: "agent", surface: "canvas", slot, program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", actor.script], cwd: directory, createdAt: 1000 })),
  } })).accepted);
  await invoke("write_pref", { key: "automationMaxAgents", value: "1" });
  await invoke("write_pref", { key: "ui.lastGroup", value: "legacy-group" });
  await page.reload();
  await page.locator(".xterm").first().waitFor();
  writeFileSync(trigger, "begin the owned pipeline");
  const acceptance = await until(() => {
    try { return JSON.parse(readFileSync(started, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(acceptance.code, 0, acceptance.output);
  await until(() => existsSync(heldStage));
  const task = await invoke("task_create", { input: { id: "legacy-peer-task", title: "Peer waits for pipeline", request: "Begin after the complete legacy pipeline", criteria: [] } });
  await invoke("task_enqueue", { id: task.id, revision: task.revision, terminalId: "legacy-peer", queueId: "legacy-peer-attempt" });
  const heldAt = Date.now();
  await until(() => Date.now() - heldAt >= 8000);
  assert(!existsSync(peerReceipt), "The native queue must retain the flow's slot while its agent is still working");
  assert.equal((await invoke("task_get", { id: task.id })).status, "queued");
  writeFileSync(releaseStage, "continue");
  await until(() => existsSync(completed));
  const observed = await until(() => {
    try { return JSON.parse(readFileSync(peerReceipt, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(observed.code, 0);
  assert.equal(JSON.parse(observed.task).request, task.request);
  writeFileSync(finish, "complete");
  return { realLegacyFlow: true, heldOutputPreservesSlot: true, queuedPeerWaitsForTheWholePipeline: true, completedPipelineReleasesSlot: true };
}

export function runNativeLegacyFlowCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseLegacyFlow, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeLegacyFlowCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
