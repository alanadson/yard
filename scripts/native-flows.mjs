/** A native pipeline must finish its stages without a renderer and retain its request across reloads. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseFlows(page, directory, assertAlive, timeoutMs) {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const release = join(directory, "release-stage");
  const finish = join(directory, "finish-agent");
  const script = join(directory, "flow-agent.ps1");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(script, `$ErrorActionPreference = 'Stop'
$client = (Get-Command yard.cmd).Source
[Console]::WriteLine('NATIVE_FLOW_READY')
foreach ($stage in @(1, 2)) {
  $stamp = [Console]::ReadLine()
  $brief = & $client flow stage --timeout 1 | Out-String
  @{ code = $LASTEXITCODE; brief = $brief; stamp = $stamp } | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path ${quote(directory)} "stage-$stage.json") -Encoding UTF8
  '{}' | & $client hook prompt --stdin --timeout 1 | Out-Null
  if ($stage -eq 1) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (!(Test-Path -LiteralPath ${quote(release)})) {
      if ([DateTime]::UtcNow -gt $deadline) { exit 9 }
      Start-Sleep -Milliseconds 25
    }
  }
  [Console]::WriteLine('### RESUMO DA ETAPA')
  [Console]::WriteLine("Verified stage $stage")
  '{}' | & $client hook stop --stdin --timeout 1 | Out-Null
}
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while (!(Test-Path -LiteralPath ${quote(finish)})) {
  if ([DateTime]::UtcNow -gt $deadline) { exit 9 }
  Start-Sleep -Milliseconds 25
}
`);
  async function until(read) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const result = await read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Native flow condition did not complete before its deadline");
  }
  const groupId = "native-flow-group";
  const terminalId = "native-flow-agent";
  const flowId = "native-pipeline";
  const stages = [{ label: "Plan", prompt: "Prepare the original request" }, { label: "Verify", prompt: "Verify the preserved plan" }];
  const canvas = { items: [{ id: flowId, type: "flow", name: "Native durable pipeline", stages, x: 0, y: 0, w: 240, h: 200, color: "#fff" }, { id: "wire", type: "connection", from: flowId, to: terminalId }] };
  const workspace = await invoke("load_workspace");
  await invoke("write_pref", { key: "onboarding.done", value: "1" });
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev, projects: [],
    groups: [{ id: groupId, projectId: null, name: "Durable flows", layoutJson: JSON.stringify({ surface: "canvas", canvas }) }],
    terminals: [{ id: terminalId, groupId, kind: "agent", program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: directory, title: "Flow fixture", surface: "canvas", createdAt: 1000 }] } })).accepted);
  await invoke("spawn_pty", { opts: { id: terminalId, program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd: directory, rows: 24, cols: 80, kind: "agent", title: "Flow fixture", env: [], keepScrollback: false } });
  let answered = 0;
  await until(async () => {
    const attached = await invoke("attach_pty", { id: terminalId });
    const requests = attached.data.split("\u001b[6n").length - 1;
    while (answered < requests) { await invoke("write_pty", { id: terminalId, data: "\u001b[1;1R" }); answered++; }
    return attached.data.includes("NATIVE_FLOW_READY");
  });
  const task = await invoke("task_create", { input: { id: "pipeline-work", title: "Native pipeline work", request: "Original native request", criteria: ["Preserve the original request"], links: { projectId: null, terminalIds: [] } } });
  await page.reload();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Tarefas e entregas");
  await page.getByRole("option").filter({ hasText: "Tarefas e entregas" }).click();
  const dialog = page.getByRole("dialog", { name: "Tarefas e entregas", exact: true });
  await dialog.getByRole("button").filter({ hasText: "Native pipeline work" }).click();
  await dialog.getByLabel("Agente executor").selectOption(terminalId);
  await dialog.getByLabel("Executar com fluxo").selectOption(flowId);
  await dialog.getByRole("button", { name: "Iniciar fluxo da tarefa", exact: true }).click();
  await until(async () => (await invoke("flow_snapshot")).find((run) => run.taskId === task.id));
  if (process.env.YARD_NATIVE_SCREENSHOT_DIR) {
    await dialog.locator(".work-detail").getByText("Em execução", { exact: true }).waitFor();
    mkdirSync(process.env.YARD_NATIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.YARD_NATIVE_SCREENSHOT_DIR, "task-pipeline.png") });
  }
  const originalUrl = page.url();
  await page.goto("about:blank");
  const first = await until(() => { try { return JSON.parse(readFileSync(join(directory, "stage-1.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; } });
  assert.equal(first.code, 0);
  assert(first.brief.includes("Original native request"));
  writeFileSync(release, "continue");
  const second = await until(() => { try { return JSON.parse(readFileSync(join(directory, "stage-2.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; } });
  assert.equal(second.code, 0);
  assert(second.brief.includes("Verified stage 1"));
  assert(second.stamp.includes("etapa 2/2"));
  await page.goto(originalUrl);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const skip = page.getByRole("button", { name: "Pular", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.getByText("Durable flows", { exact: true }).last().click();
  const completed = await until(async () => (await invoke("flow_snapshot")).find((run) => run.flowId === flowId && run.finishedAt));
  assert.equal(completed.phase, "done");
  assert.equal(completed.current, 2);
  assert.equal(completed.error, null);
  const review = await invoke("task_get", { id: task.id });
  assert.equal(review.status, "in_review");
  assert(review.delivery.summary.includes("Verified stage 2"));
  assert.equal(review.delivery.checks.length, 0);
  assert.equal(review.criteria[0].text, "Preserve the original request");
  assert(review.links.resources.some((resource) => resource.kind === "flow" && resource.id === flowId));
  await page.locator(".cv-flowrun-name").filter({ hasText: "Native durable pipeline" }).getByText("concluído", { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  assert.equal((await invoke("flow_snapshot"))[0].phase, "done");
  writeFileSync(finish, "complete");
  return { stagesWithoutRenderer: true, authenticatedStageCli: true, previousSummaryPreserved: true, completedRunSurvivesReload: true, taskStartedFromPanel: true, taskAwaitingEvidenceReview: true };
}

export function runNativeFlowsCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseFlows, options); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeFlowsCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
