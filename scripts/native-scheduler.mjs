/** Exercise native automation with the application page unloaded. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseScheduler(page, directory, assertAlive, timeoutMs) {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const root = join(directory, "checkpoint-repository");
  mkdirSync(root);
  execFileSync("git", ["init", root], { windowsHide: true, stdio: "ignore" });
  writeFileSync(join(root, "code.txt"), "Original native file\n");
  const trigger = join(directory, "begin-hooks");
  const result = join(directory, "hook-result.json");
  const receipt = join(directory, "native-queue-receipt.json");
  const routineReceipt = join(directory, "native-routine-receipt.json");
  const taskResult = join(directory, "native-task-result.json");
  const report = join(directory, "native-task-report.json");
  const proof = join(directory, "native-task-proof.txt");
  const finish = join(directory, "finish-native-agent");
  writeFileSync(report, JSON.stringify({ delivery: { summary: "Native task verified without renderer", artifacts: [proof], checks: [{ name: "Original request", passed: true, evidence: proof }] }, evidence: { "criterion-1": [proof] } }));
  const script = join(directory, "owned-hook-agent.ps1");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
[Console]::WriteLine('OWNED_HOOK_READY')
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath ${quote(trigger)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 9 }
  Start-Sleep -Milliseconds 25
}
$codes = @()
$outputs = @()
$client = (Get-Command yard.cmd).Source
foreach ($verb in @('prompt', 'permission', 'stop')) {
  $output = '{}' | & $client hook $verb --stdin --timeout 1 | Out-String
  $codes += $LASTEXITCODE
  $outputs += $output
}
@{ codes = $codes; outputs = $outputs } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(result)} -Encoding UTF8
$line = [Console]::ReadLine()
@{ body = $line } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(receipt)} -Encoding UTF8
'Changed native file' | Set-Content -LiteralPath ${quote(join(root, "code.txt"))} -Encoding UTF8
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
$managed = [Console]::ReadLine()
$shown = & $client task show native-managed --timeout 1 | Out-String
$showCode = $LASTEXITCODE
$shown | Set-Content -LiteralPath ${quote(proof)} -Encoding UTF8
$submitted = & $client task submit native-managed --attempt native-managed-attempt --file ${quote(report)} --timeout 1 | Out-String
$submitCode = $LASTEXITCODE
$history = & $client task history native-managed --timeout 1 | Out-String
$historyCode = $LASTEXITCODE
@{ codes = @($showCode, $submitCode, $historyCode); shown = $shown; submitted = $submitted; history = $history } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(taskResult)} -Encoding UTF8
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
$routine = [Console]::ReadLine()
@{ body = $routine } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(routineReceipt)} -Encoding UTF8
'{}' | & $client hook stop --stdin --timeout 1 | Out-Null
$finishDeadline = [DateTime]::UtcNow.AddSeconds(30)
while (!(Test-Path -LiteralPath ${quote(finish)})) {
  if ([DateTime]::UtcNow -gt $finishDeadline) { exit 9 }
  Start-Sleep -Milliseconds 25
}
`);
  await invoke("spawn_pty", { opts: { id: "owned-hook-agent", program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: root, rows: 24, cols: 80, kind: "agent", title: "Owned hook agent", env: [], keepScrollback: false } });
  const deadline = Date.now() + timeoutMs;
  async function until(read) {
    while (Date.now() < deadline) {
      assertAlive();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Native automation condition did not complete before its deadline");
  }
  let answered = 0;
  await until(async () => {
    const attached = await invoke("attach_pty", { id: "owned-hook-agent" });
    const requests = attached.data.split("\u001b[6n").length - 1;
    while (answered < requests) { await invoke("write_pty", { id: "owned-hook-agent", data: "\u001b[1;1R" }); answered++; }
    return attached.data.includes("OWNED_HOOK_READY");
  });
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "native-automation-project", name: "Native automation", path: directory, createdAt: 1000 }],
    groups: [{ id: "native-automation-group", projectId: "native-automation-project", name: "Native automation", layoutJson: JSON.stringify({ canvas: { routines: [{ id: "native-once", terminalId: "owned-hook-agent", text: "Native routine without renderer", everyMin: 1, enabled: true, once: true, createdAt: 1000 }] } }) }],
    terminals: [{ id: "owned-hook-agent", groupId: "native-automation-group", kind: "agent", program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: root, title: "Owned hook agent", createdAt: 1000 }],
  } })).accepted);
  await invoke("queue_patch", { before: [], after: [{ id: "without-renderer", terminalId: "owned-hook-agent", text: "Native scheduler request", at: 1000, source: "user" }] });
  const managed = await invoke("task_create", { input: { id: "native-managed", title: "Native task without renderer", request: "Read the original managed request without a page", criteria: ["The native CLI preserves the original request."] } });
  await invoke("task_enqueue", { id: managed.id, revision: managed.revision, terminalId: "owned-hook-agent", queueId: "native-managed-attempt" });
  await page.goto("about:blank");
  writeFileSync(trigger, "ready");
  const observed = await until(() => {
    try { return JSON.parse(readFileSync(result, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.deepEqual(observed.codes, [0, 0, 0], `native hooks must complete without a renderer listener: ${JSON.stringify(observed)}`);
  const received = await until(() => {
    try { return JSON.parse(readFileSync(receipt, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(received.body, "Native scheduler request");
  const taskObserved = await until(() => {
    try { return JSON.parse(readFileSync(taskResult, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.deepEqual(taskObserved.codes, [0, 0, 0], `task commands must complete without a renderer: ${JSON.stringify(taskObserved)}`);
  assert.equal(JSON.parse(taskObserved.shown).request, managed.request);
  assert.equal(JSON.parse(taskObserved.submitted).status, "in_review");
  assert.equal(JSON.parse(taskObserved.history).length, 1);
  const routineObserved = await until(() => {
    try { return JSON.parse(readFileSync(routineReceipt, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(routineObserved.body, "Native routine without renderer");
  await page.goto("http://tauri.localhost");
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const own = await until(async () => {
    const records = (await invoke("native_hook_snapshot")).filter((record) => record.terminalId === "owned-hook-agent");
    return records[0]?.event.kind === "turn-end" && records[0]?.sequence >= 9 ? records : null;
  });
  assert.equal(own.length, 1);
  assert.equal(own[0].event.kind, "turn-end");
  assert.equal(own[0].sequence, 9);
  assert.equal((await invoke("task_get", { id: managed.id })).status, "in_review");
  assert.deepEqual(await invoke("queue_read"), []);
  const routineRuns = await invoke("routine_snapshot");
  const routineRun = routineRuns.find((row) => row.routineId === "native-once");
  assert.equal(routineRun?.status, "delivered");
  assert.equal(routineRun.routine.text, "Native routine without renderer");
  assert(routineRun.lastRunAt >= routineRun.scheduledAt);
  await page.locator(".xterm").waitFor();
  await page.locator(".xterm").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Rotinas e gatilhos da CLI em foco");
  await page.getByRole("option").filter({ hasText: "Rotinas e gatilhos da CLI em foco" }).click();
  const routinePanel = page.getByRole("dialog").filter({ hasText: "Native routine without renderer" });
  await routinePanel.getByText("Lembrete entregue.", { exact: false }).waitFor();
  const routineScreenshot = join(tmpdir(), `yard-native-routines-${Date.now()}.png`);
  await page.screenshot({ path: routineScreenshot });
  await routinePanel.getByRole("button", { name: "Retomar rotina", exact: true }).click();
  await until(async () => {
    const saved = await invoke("load_workspace");
    const routine = JSON.parse(saved.groups[0].layoutJson).canvas.routines[0];
    return routine.createdAt > 1000 && routine.enabled;
  });
  await routinePanel.getByRole("button", { name: "Pausar rotina", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  const checkpoints = await invoke("checkpoint_list", { root });
  const checkpoint = checkpoints.find((row) => row.taskId === "without-renderer");
  assert(checkpoint, "Native scheduled user delivery must capture a checkpoint before writing to the agent");
  const comparison = await invoke("checkpoint_compare", { root, id: checkpoint.id, path: "code.txt" });
  assert.equal(comparison.before, "Original native file\n");
  assert(comparison.after.includes("Changed native file"));
  return { realAuthenticatedCliHooks: true, hooksCompleteWithoutRenderer: true, nativeStateSurvivesRendererReload: true, durableQueueRunsWithoutRenderer: true, managedTaskCliWithoutRenderer: true, nativeSubmissionWaitsForReview: true, nativeDeliveryPreservesCheckpoint: true, nativeRoutineWithoutRenderer: true, nativeRoutineRearmsInUi: true, routineScreenshot };
}

export function runNativeSchedulerCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseScheduler, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeSchedulerCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
