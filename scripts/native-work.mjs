/** Exercise the native task, ConPTY, real CLI and human review using an isolated workspace. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isolatedSmokeEnvironment } from "./smoke.mjs";

const poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function condition(label, read, assertAlive, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertAlive();
    const value = await read();
    assertAlive();
    if (value) return value;
    await poll(50);
  }
  assertAlive();
  throw new Error(`Timed out: ${label}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function removeOwnedData(dir) {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert(basename(dir).startsWith("yard-native-work-"));
  await condition("native browser releases isolated data", () => {
    try { rmSync(dir, { recursive: true, force: true }); return true; }
    catch (error) { if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; return false; }
  }, () => {}, 10000);
}

export function ownsNativeBrowserProfile(name, commandLine, profile) {
  if (name?.toLowerCase() !== "msedgewebview2.exe") return false;
  const match = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(commandLine ?? "");
  return (match?.[1] ?? match?.[2])?.toLowerCase() === profile.toLowerCase();
}

async function releaseOwnedBrowserWorkers(dir) {
  if (process.platform !== "win32") return;
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert(basename(dir).startsWith("yard-native-work-"));
  const inventory = await new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Select-Object Name,ProcessId,CommandLine) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 15000, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  const parsed = inventory.trim() ? JSON.parse(inventory) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const profile = join(dir, "webview", "EBWebView");
  for (const process of processes) {
    if (!ownsNativeBrowserProfile(process.Name, process.CommandLine, profile)) continue;
    await new Promise((resolve) => {
      const stop = spawn("taskkill.exe", ["/PID", String(process.ProcessId), "/F"], { windowsHide: true, stdio: "ignore" });
      stop.once("error", resolve);
      stop.once("exit", resolve);
    });
  }
}

const FIXTURE = `# This fixture treats received prompts as data and invokes only the task CLI.
$taskRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskId = $null
$taskAttempt = $null
Write-Output 'NATIVE_WORK_READY'
while ($true) {
  $taskLine = [Console]::ReadLine()
  if ($null -eq $taskLine) { break }
  if ($taskLine -eq 'BLOCK_QUEUE') { Write-Output 'Proceed? (y/N)' }
  if ($taskLine -eq 'UNBLOCK_QUEUE') { 1..20 | ForEach-Object { Write-Output 'NATIVE_WORK_READY' } }
  $taskMatch = [regex]::Match($taskLine, '\\[Yard task ([A-Za-z0-9_-]+)\\]')
  if ($taskMatch.Success) {
    $taskId = $taskMatch.Groups[1].Value
    $taskShown = & $env:YARD_CLI task show $taskId
    $taskShown | Set-Content -LiteralPath (Join-Path $taskRoot 'received.json') -Encoding utf8
    $taskAttempt = ($taskShown | ConvertFrom-Json).links.queueItemId
  }
  if ($taskLine.StartsWith('REPORT ') -and $taskId) {
    & $env:YARD_CLI task submit $taskId --attempt $taskAttempt --file $taskLine.Substring(7).Trim() |
      Set-Content -LiteralPath (Join-Path $taskRoot 'submitted.json') -Encoding utf8
  }
  if ($taskLine -eq 'HISTORY' -and $taskId) {
    & $env:YARD_CLI task history $taskId | Set-Content -LiteralPath (Join-Path $taskRoot 'history.json') -Encoding utf8
  }
}
`;

async function exerciseWork(page, dir, assertAlive, timeoutMs) {
  const capture = async (name) => {
    await page.evaluate(() => Promise.all([...document.querySelectorAll(".modal, .modal-backdrop")].flatMap((element) => element.getAnimations().map((animation) => animation.finished.catch(() => {})))));
    await page.screenshot({ path: join(dir, name) });
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const now = Date.now();
  const fixture = join(dir, "agent.ps1");
  writeFileSync(fixture, FIXTURE);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const snapshot = await invoke("load_workspace");
  const saved = await invoke("save_workspace", { snapshot: { rev: snapshot.rev,
    projects: [{ id: "native-project", name: "Native work check", path: home, createdAt: now }],
    groups: [{ id: "native-group", projectId: "native-project", name: "Checks", layoutJson: "{}" }],
    terminals: [{ id: "native-agent", groupId: "native-group", title: "Native task fixture", kind: "agent", agentId: "claude", surface: "grid",
      program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture], cwd: home, createdAt: now }],
  } });
  assert(saved.accepted);
  await page.reload();
  await condition("native process is live", async () => {
    const probe = await invoke("pty_read_since", { id: "native-agent", after: 0, maxBytes: 1 });
    if (probe.alive) return true;
    const start = page.locator(".pane-exit-banner").getByRole("button", { name: /^(Retomar|Começar do zero)$/ });
    if (await start.isVisible()) await start.click();
    return false;
  }, assertAlive, timeoutMs);
  async function panel() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Tarefas e entregas");
    await page.getByRole("option").filter({ hasText: "Tarefas e entregas" }).click();
    const dialog = page.getByRole("dialog", { name: "Tarefas e entregas", exact: true });
    await dialog.waitFor();
    return dialog;
  }
  const observedPrompt = { id: "patch-observed", terminalId: "native-agent", text: "Observed request", at: now, source: "user" };
  assert.deepEqual(await invoke("queue_remove", { id: "already-removed", attemptedAt: null }), []);
  const localPrompt = { ...observedPrompt, id: "patch-added", text: "Added request" };
  await invoke("write_pref", { key: "queue.items", value: JSON.stringify([observedPrompt]) });
  const patchTask = await invoke("task_create", { input: { id: "queue-patch-work", title: "Queue patch fixture", request: "Preserve independently queued native work", criteria: [] } });
  const nativeQueued = await invoke("task_enqueue", { id: patchTask.id, revision: patchTask.revision, terminalId: "native-agent", queueId: "patch-native-task" });
  const patched = await invoke("queue_patch", { before: [observedPrompt], after: [observedPrompt, localPrompt] });
  assert.deepEqual(patched.map((item) => item.id), ["patch-observed", "patch-native-task", "patch-added"]);
  assert.equal((await invoke("task_get", { id: patchTask.id })).status, "queued");
  await invoke("queue_patch", { before: patched, after: patched.filter((item) => item.id !== observedPrompt.id) });
  await invoke("task_transition", { id: patchTask.id, revision: nativeQueued.task.revision, status: "cancelled" });
  await invoke("queue_patch", { before: [localPrompt], after: [] });
  assert.deepEqual(JSON.parse((await invoke("read_prefs"))["queue.items"]), []);
  await invoke("write_pty", { id: "native-agent", data: "BLOCK_QUEUE\r" });
  await page.keyboard.press("Control+Enter");
  const composer = page.getByRole("dialog", { name: "Compositor de prompts", exact: true });
  await composer.waitFor();
  await composer.getByRole("textbox").fill("Request preserved after a queue save failure");
  await composer.getByRole("button", { name: "Enfileirar", exact: true }).waitFor();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("queue_patch", "ipc");
    window.__yardQueueOriginalFetch = original;
    window.__yardQueueMode = "failure";
    window.__yardQueueRequests = 0;
    window.fetch = (input, init) => {
      if (String(input) !== url || !window.__yardQueueMode) return original(input, init);
      window.__yardQueueRequests++;
      const mode = window.__yardQueueMode;
      window.__yardQueueMode = null;
      return new Promise((resolve) => {
        window.__yardReleaseQueue = () => mode === "failure"
          ? resolve(new Response(JSON.stringify("Controlled queue write failure"), { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } }))
          : resolve(original(input, init));
      });
    };
  });
  await composer.getByRole("button", { name: "Enfileirar", exact: true }).click();
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor();
  assert.equal(JSON.parse((await invoke("read_prefs"))["queue.items"]).length, 0);
  await page.evaluate(() => window.__yardReleaseQueue());
  await page.getByText("Não consegui salvar o pedido na fila. Seu texto foi preservado.", { exact: true }).waitFor();
  assert.equal(await composer.getByRole("textbox").inputValue(), "Request preserved after a queue save failure");
  assert.equal(JSON.parse((await invoke("read_prefs"))["queue.items"]).length, 0);
  await composer.getByRole("textbox").fill("Request accepted by durable queue");
  await page.evaluate(() => { window.__yardQueueMode = "hold"; window.__yardQueueRequests = 0; });
  await composer.getByRole("button", { name: "Enfileirar", exact: true }).click();
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor();
  await composer.getByRole("textbox").fill("Newer draft written during acknowledgement");
  await composer.getByRole("textbox").press("Control+Enter");
  assert.equal(await page.evaluate(() => window.__yardQueueRequests), 1);
  await page.evaluate(() => window.__yardReleaseQueue());
  await page.getByText(/Na fila de Native task fixture/).waitFor();
  assert.equal(await composer.getByRole("textbox").inputValue(), "Newer draft written during acknowledgement");
  const acceptedQueue = JSON.parse((await invoke("read_prefs"))["queue.items"]);
  assert.equal(acceptedQueue.length, 1);
  assert.equal(acceptedQueue[0].text, "Request accepted by durable queue");
  await composer.getByRole("button", { name: "Fechar compositor", exact: true }).click();
  await page.evaluate(() => { window.fetch = window.__yardQueueOriginalFetch; });
  await invoke("queue_patch", { before: acceptedQueue, after: [] });
  await page.reload();
  await page.locator(".xterm").waitFor();
  let interruptedPrompt = { id: "reviewed-old-attempt", terminalId: "native-agent", text: "Retain the reviewed request", at: now,
    source: "user", delivery: { status: "sending", attemptedAt: now } };
  await invoke("write_pref", { key: "queue.items", value: JSON.stringify([interruptedPrompt]) });
  const reviewedRetry = await invoke("queue_retry", { id: interruptedPrompt.id, newId: "reviewed-new-attempt", attemptedAt: now });
  assert.equal(reviewedRetry[0].id, "reviewed-new-attempt");
  assert.equal(reviewedRetry[0].text, interruptedPrompt.text);
  assert.equal(reviewedRetry[0].delivery, undefined);
  await invoke("queue_patch", { before: reviewedRetry, after: [] });
  await assert.rejects(invoke("queue_patch", { before: [], after: [interruptedPrompt] }), (error) => String(error).includes("QUEUE_ID_RETIRED"));
  interruptedPrompt = { ...interruptedPrompt, id: "reviewed-reload-attempt" };
  async function queuePanel() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Fila de trabalho");
    await page.getByRole("option").filter({ hasText: "Fila de trabalho" }).click();
    const dialog = page.getByRole("dialog", { name: "Fila de trabalho", exact: true });
    await dialog.waitFor();
    return dialog;
  }
  await invoke("write_pref", { key: "queue.items", value: JSON.stringify([interruptedPrompt]) });
  await page.reload();
  let queue = await queuePanel();
  await queue.getByText("Conferir entrega", { exact: true }).waitFor();
  assert.equal(JSON.parse((await invoke("read_prefs"))["queue.items"])[0].delivery.status, "sending");
  await queue.getByRole("button", { name: "Reenviar após conferir", exact: true }).click();
  await page.getByRole("dialog", { name: "Reenviar após conferir", exact: true }).getByRole("button", { name: "Cancelar", exact: true }).click();
  assert.equal(JSON.parse((await invoke("read_prefs"))["queue.items"])[0].id, interruptedPrompt.id);
  await queue.getByRole("button", { name: "Reenviar após conferir", exact: true }).click();
  await page.getByRole("dialog", { name: "Reenviar após conferir", exact: true }).getByRole("button", { name: "Reenviar", exact: true }).click();
  await queue.getByText("Aguardando", { exact: true }).waitFor();
  const retriedAfterReload = JSON.parse((await invoke("read_prefs"))["queue.items"]);
  assert.equal(retriedAfterReload.length, 1);
  assert.notEqual(retriedAfterReload[0].id, interruptedPrompt.id);
  assert.equal(retriedAfterReload[0].text, interruptedPrompt.text);
  assert.equal(retriedAfterReload[0].delivery, undefined);
  await queue.getByRole("button", { name: "Remover da fila", exact: true }).click();
  await queue.getByText("Nenhum prompt na fila.", { exact: true }).waitFor();
  assert.deepEqual(JSON.parse((await invoke("read_prefs"))["queue.items"]), []);
  interruptedPrompt = { ...interruptedPrompt, id: "reviewed-removal-attempt" };
  await invoke("write_pref", { key: "queue.items", value: JSON.stringify([interruptedPrompt]) });
  await page.reload();
  queue = await queuePanel();
  await queue.getByText("Conferir entrega", { exact: true }).waitFor();
  await queue.getByRole("button", { name: "Remover da fila", exact: true }).click();
  await queue.getByText("Nenhum prompt na fila.", { exact: true }).waitFor();
  assert.deepEqual(JSON.parse((await invoke("read_prefs"))["queue.items"]), []);
  await page.keyboard.press("Escape");
  await invoke("write_pty", { id: "native-agent", data: "UNBLOCK_QUEUE\r" });
  await page.reload();
  await page.keyboard.press("Control+Enter");
  await composer.waitFor();
  await composer.getByRole("combobox").click();
  await page.getByRole("option").filter({ hasText: "Native task fixture" }).click();
  await composer.getByRole("textbox").fill("Direct request accepted by native input");
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("write_pty", "ipc");
    window.__yardDirectOriginalFetch = original;
    window.__yardDirectPending = true;
    window.__yardDirectRequests = 0;
    window.fetch = (input, init) => {
      if (String(input) !== url || !window.__yardDirectPending) return original(input, init);
      window.__yardDirectRequests += 1;
      return original(input, init).then((response) => new Promise((resolve) => {
        window.__yardReleaseDirect = () => { window.__yardDirectPending = false; resolve(response); };
      }));
    };
  });
  await composer.getByRole("textbox").evaluate((area) => {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor();
  await page.waitForFunction(() => !!window.__yardReleaseDirect);
  assert.equal(await page.evaluate(() => window.__yardDirectRequests), 1, "one composer accepts one pending submission across both delivery actions");
  await composer.getByRole("textbox").fill("Newer draft written during direct delivery");
  await page.evaluate(() => window.__yardReleaseDirect());
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor({ state: "hidden" });
  await composer.waitFor();
  assert.equal(await composer.getByRole("textbox").inputValue(), "Newer draft written during direct delivery");
  await composer.getByRole("button", { name: "Fechar compositor", exact: true }).click();
  await page.evaluate(() => { window.fetch = window.__yardDirectOriginalFetch; });
  await page.keyboard.press("Control+Enter");
  await composer.waitFor();
  await composer.getByRole("textbox").fill("Manual request left on the native input line");
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("write_pty", "ipc");
    window.__yardDirectOriginalFetch = original;
    window.__yardReleaseDirect = null;
    window.__yardDirectPending = true;
    window.fetch = (input, init) => {
      if (String(input) !== url || !window.__yardDirectPending) return original(input, init);
      return original(input, init).then((response) => new Promise((resolve) => {
        window.__yardReleaseDirect = () => { window.__yardDirectPending = false; resolve(response); };
      }));
    };
  });
  await composer.getByRole("button", { name: "Deixar na CLI", exact: true }).click();
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor();
  await page.waitForFunction(() => !!window.__yardReleaseDirect);
  await composer.getByRole("textbox").fill("Newer draft written during manual delivery");
  await page.evaluate(() => window.__yardReleaseDirect());
  await composer.getByRole("button", { name: "Enviando…", exact: true }).waitFor({ state: "hidden" });
  await composer.waitFor();
  assert.equal(await composer.getByRole("textbox").inputValue(), "Newer draft written during manual delivery");
  await composer.getByRole("button", { name: "Fechar compositor", exact: true }).click();
  await page.evaluate(() => { window.fetch = window.__yardDirectOriginalFetch; });
  await invoke("write_pty", { id: "native-agent", data: "\r" });
  const nativeRequest = { id: "native-acknowledgment-request", terminalId: "native-agent", text: "Durable native queue fixture", at: 4000, source: "bridge" };
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("queue_dispatch", "ipc");
    let held = false;
    window.fetch = (input, init) => {
      if (String(input) !== url || held) return original(input, init);
      held = true;
      return original(input, init).then((response) => new Promise((resolve) => { window.__yardReleaseNativeQueue = () => resolve(response); }));
    };
  });
  await invoke("queue_patch", { before: [], after: [nativeRequest] });
  await page.evaluate(({ id, terminalId }) => {
    window.__TAURI_INTERNALS__.invoke("queue_dispatch", { id, terminalId, attemptedAt: 5000 }).catch(() => {});
  }, nativeRequest);
  await page.waitForFunction(() => !!window.__yardReleaseNativeQueue);
  const completedBeforeAcknowledgment = await invoke("read_prefs");
  assert.deepEqual(JSON.parse(completedBeforeAcknowledgment["queue.items"]), [], "native completion must be saved before the renderer receives its acknowledgment");
  assert.equal(completedBeforeAcknowledgment["queue.retired.native-acknowledgment-request"], "1");
  await page.reload();
  assert.deepEqual(JSON.parse((await invoke("read_prefs"))["queue.items"]), []);
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("queue_read", "ipc");
    window.__yardQueueReadOriginal = original;
    window.fetch = (input, init) => String(input) === url
      ? Promise.resolve(new Response(JSON.stringify("Controlled queue read failure"), { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } }))
      : original(input, init);
  });
  const failedQueue = await queuePanel();
  await failedQueue.getByRole("alert").getByText("Não foi possível sincronizar a fila. Confira os pedidos antes de continuar.", { exact: true }).waitFor();
  assert.equal(await failedQueue.getByText("Nenhum prompt na fila.", { exact: true }).count(), 0);
  await page.evaluate(() => { window.fetch = window.__yardQueueReadOriginal; });
  await failedQueue.getByText("Nenhum prompt na fila.", { exact: true }).waitFor();
  assert.equal(await failedQueue.getByRole("alert").count(), 0);
  await page.keyboard.press("Escape");
  let dialog = await panel();
  await dialog.getByRole("button", { name: "Nova tarefa", exact: true }).click();
  const request = "Verify native input, durable reports and explicit review.";
  await dialog.getByLabel("Título da tarefa", { exact: true }).fill("Native end-to-end task");
  await dialog.getByLabel("Pedido original", { exact: true }).fill(request);
  await dialog.getByLabel("Critérios de aceite, um por linha", { exact: true }).fill("The real CLI reads the original request.");
  await dialog.getByRole("button", { name: "Criar tarefa", exact: true }).click();
  await dialog.locator(".work-send select").selectOption("native-agent");
  await dialog.getByRole("button", { name: "Enviar para a fila do agente", exact: true }).click();
  const task = await condition("real CLI receives queued task", () => {
    try { return JSON.parse(readFileSync(join(dir, "received.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  }, assertAlive, timeoutMs);
  assert.equal(task.request, request);
  assert.equal(task.status, "running");
  assert(task.links.queueItemId);
  const reportPath = join(dir, "report.json");
  writeFileSync(reportPath, JSON.stringify({ delivery: { summary: "Intentional failed validation", artifacts: [], checks: [{ name: "Proof check", passed: false, evidence: "Intentional failure" }] }, evidence: {} }));
  await invoke("write_pty", { id: "native-agent", data: `REPORT ${reportPath}\r` });
  await condition("failed validation stays in review", async () => (await invoke("task_get", { id: task.id })).status === "in_review", assertAlive, timeoutMs);
  dialog = await panel();
  await dialog.locator(".work-task").filter({ hasText: "Native end-to-end task" }).click();
  await dialog.getByRole("button", { name: "Aprovar entrega", exact: true }).click();
  await page.getByRole("dialog", { name: "Aprovar entrega", exact: true }).getByRole("button", { name: "Aprovar", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await invoke("task_get", { id: task.id })).status, "in_review");
  const attention = dialog.getByRole("button", { name: "Precisa de atenção (1)", exact: true });
  await attention.click();
  assert.equal(await attention.getAttribute("aria-pressed"), "true");
  await condition("attention filter finishes loading its task", async () => (await dialog.locator(".work-task").count()) === 1, assertAlive, timeoutMs);
  assert.equal(await dialog.locator(".work-task").count(), 1);
  await page.setViewportSize({ width: 640, height: 720 });
  await capture("rejected.png");
  await dialog.getByRole("button", { name: "Reabrir para ajustes", exact: true }).click();
  await condition("task reopened", async () => (await invoke("task_get", { id: task.id })).status === "running", assertAlive, timeoutMs);
  const proof = join(dir, "received.json");
  writeFileSync(reportPath, JSON.stringify({ delivery: { summary: "Native request verified", artifacts: [proof], checks: [{ name: "Native request", passed: true, evidence: proof }] }, evidence: { [task.criteria[0].id]: [proof] } }));
  await invoke("write_pty", { id: "native-agent", data: `REPORT ${reportPath}\r` });
  await condition("corrected report recorded", async () => (await invoke("task_get", { id: task.id })).status === "in_review", assertAlive, timeoutMs);
  await invoke("write_pty", { id: "native-agent", data: "HISTORY\r" });
  const history = await condition("real CLI returns both reports", () => {
    try { const rows = JSON.parse(readFileSync(join(dir, "history.json"), "utf8").replace(/^\uFEFF/, "")); return rows.length === 2 ? rows : null; } catch { return null; }
  }, assertAlive, timeoutMs);
  assert.equal(history[0].delivery.checks[0].passed, false);
  assert.equal(history[1].delivery.summary, "Native request verified");
  dialog = await panel();
  await dialog.getByRole("button", { name: "Aprovar entrega", exact: true }).click();
  await page.getByRole("dialog", { name: "Aprovar entrega", exact: true }).getByRole("button", { name: "Aprovar", exact: true }).click();
  await condition("explicit approval completed work", async () => (await invoke("task_get", { id: task.id })).status === "completed", assertAlive, timeoutMs);
  await page.reload();
  dialog = await panel();
  await dialog.locator(".work-task").filter({ hasText: "Native end-to-end task" }).click();
  await dialog.locator(".work-history summary").click();
  await dialog.locator(".work-history").getByText("Intentional failed validation", { exact: true }).waitFor();
  assert.equal((await invoke("task_get", { id: task.id })).status, "completed");
  assert.equal((await invoke("task_deliveries", { id: task.id })).length, 2);
  await dialog.getByRole("button", { name: "Precisa de atenção (0)", exact: true }).click();
  await dialog.getByText("Nenhuma tarefa registrada.", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".work-task").count(), 0);
  assert.deepEqual(errors, []);
  await capture("approved-history.png");
  await page.keyboard.press("Escape");
  await invoke("kill_pty", { id: "native-agent" });
  const start = page.locator(".pane-exit-banner").getByRole("button", { name: "Começar do zero", exact: true });
  await start.waitFor();
  const previousOutput = readFileSync(join(dir, "scrollback", "native-agent.bin"));
  assert(previousOutput.length > 0);
  await start.click();
  await condition("fresh native session starts", async () => (await invoke("pty_read_since", { id: "native-agent", after: 0, maxBytes: 1 })).alive, assertAlive, timeoutMs);
  const archives = await invoke("pty_archives", { id: "native-agent" });
  assert.equal(archives.length, 1);
  const archive = archives[0];
  const exported = join(dir, "previous-session.ansi");
  await invoke("pty_archive_export", { id: archive.terminalId, name: archive.name, dest: exported, plain: false });
  assert.deepEqual(readFileSync(exported), previousOutput);
  const oldPreview = await invoke("pty_archive_preview", { id: archive.terminalId, name: archive.name, maxBytes: 64 * 1024 });
  assert(oldPreview.text.includes("NATIVE_WORK_READY"));
  async function outputPanel() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Histórico de saída");
    await page.getByRole("option").filter({ hasText: "Histórico de saída" }).click();
    const dialog = page.getByRole("dialog", { name: "Histórico de saída", exact: true });
    await dialog.waitFor();
    return dialog;
  }
  let output = await outputPanel();
  await condition("archived output is visible", async () => (await output.locator(".output-history-preview pre").innerText()).includes("NATIVE_WORK_READY"), assertAlive, timeoutMs);
  await capture("output-history.png");
  await output.getByRole("button", { name: "Excluir registro", exact: true }).click();
  await page.getByRole("dialog", { name: "Excluir registros arquivados", exact: true }).getByRole("button", { name: "Cancelar", exact: true }).click();
  assert.equal((await invoke("pty_archives", { id: "native-agent" })).length, 1);
  await output.getByRole("button", { name: "Excluir registro", exact: true }).click();
  await page.getByRole("dialog", { name: "Excluir registros arquivados", exact: true }).getByRole("button", { name: "Excluir", exact: true }).click();
  await output.getByText("Nenhuma sessão arquivada.", { exact: true }).waitFor();
  assert.equal((await invoke("pty_read_since", { id: "native-agent", after: 0, maxBytes: 1 })).alive, true);
  await page.keyboard.press("Escape");
  await invoke("kill_pty", { id: "native-agent" });
  await start.waitFor();
  await start.click();
  await condition("replacement session is live", async () => (await invoke("pty_read_since", { id: "native-agent", after: 0, maxBytes: 1 })).alive, assertAlive, timeoutMs);
  const retained = await invoke("pty_archives", { id: "native-agent" });
  assert.equal(retained.length, 1);
  await invoke("kill_pty", { id: "native-agent" });
  await start.waitFor();
  const current = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { ...current, terminals: [] } })).accepted);
  await page.reload();
  output = await outputPanel();
  await output.locator(".output-history-record").waitFor();
  assert.equal((await invoke("pty_archives", { id: null })).length, 1);
  await condition("removed terminal output is visible", async () => (await output.locator(".output-history-preview pre").innerText()).includes("NATIVE_WORK_READY"), assertAlive, timeoutMs);
  await capture("removed-terminal-history.png");
  assert.deepEqual(errors, []);
  return { taskId: task.id, realCli: true, reviewGuard: true, reports: history.length, reloadPersistence: true, attentionFilter: true,
    archivedOutput: true, originalBytesExported: true, deletionRequiresConfirmation: true, currentSessionPreserved: true, removedTerminalHistory: true,
    atomicQueuePatches: true, independentlyQueuedTaskPreserved: true, composerQueueFailureKeepsDraft: true,
    queueAcceptanceWaitsForPersistence: true, newerComposerDraftPreserved: true, duplicatePendingClickSuppressed: true,
    interruptedQueueRequiresReviewAfterReload: true, retryUsesFreshAttempt: true, reviewedRemovalAfterReload: true,
    retiredAttemptsCannotBeRestored: true, newerDirectComposerDraftPreserved: true, newerManualComposerDraftPreserved: true,
    simultaneousComposerActionsWriteOnce: true, nativeQueueCompletionSurvivesLostAcknowledgment: true, queueReadFailureIsVisibleAndRecoverable: true };
}

export async function runNativeAppCheck(exe, exercise, { args = [], timeoutMs = 30000, keepFailureData = true, playwrightModule = process.env.YARD_PLAYWRIGHT_MODULE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yard-native-work-"));
  const port = await availablePort();
  const child = spawn(exe, args, { windowsHide: true, stdio: "ignore", env: { ...isolatedSmokeEnvironment(process.env, dir),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` } });
  let outcome = null;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { outcome = { error }; resolve(); });
    child.once("exit", (code, signal) => { outcome = { code, signal }; resolve(); });
  });
  const assertAlive = () => { if (outcome) throw new Error(outcome.error?.message ?? `Native process exited with code ${outcome.code} (${outcome.signal ?? "no signal"})`); };
  let browser;
  let succeeded = false;
  try {
    await condition("native browser endpoint", async () => {
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(250) }); return response.ok; } catch { return false; }
    }, assertAlive, timeoutMs);
    const driver = await import(playwrightModule ? pathToFileURL(resolve(playwrightModule, "index.mjs")).href : "playwright").catch(() => {
      throw new Error("Provide an existing Playwright module directory through YARD_PLAYWRIGHT_MODULE. No package is installed by this check.");
    });
    browser = await driver.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await condition("native main WebView", () => browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith("http://tauri.localhost")), assertAlive, timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    const result = await exercise(page, dir, assertAlive, timeoutMs);
    assertAlive();
    succeeded = true;
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const page = browser?.contexts().flatMap((context) => context.pages())[0];
    if (page) {
      try {
        writeFileSync(join(dir, "failure.txt"), await page.locator("body").innerText());
        await page.screenshot({ path: join(dir, "failure.png") });
      } catch { /* Process failure can make the WebView unavailable. */ }
    }
    failure.message += `\nIsolated check data: ${dir}`;
    throw failure;
  } finally {
    // WebView workers can outlive an abrupt app exit and keep the isolated profile locked.
    if (browser && !outcome && process.platform === "win32" && child.pid) {
      await new Promise((resolve) => {
        const stop = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        stop.once("error", resolve);
        stop.once("exit", resolve);
      });
    }
    await browser?.close().catch(() => {});
    if (!outcome) child.kill();
    await Promise.race([exited, poll(5000)]);
    if (!outcome) { child.kill("SIGKILL"); await Promise.race([exited, poll(5000)]); }
    if (browser) await releaseOwnedBrowserWorkers(dir);
    if (succeeded || !keepFailureData) await removeOwnedData(dir);
  }
}

export function runNativeWorkCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseWork, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeWorkCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
