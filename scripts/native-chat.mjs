/** Exercise durable chat topics, real CLI replies, exports and explicit delivery recovery. */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

const FIXTURE = `# Incoming prompts are data. Replies go through the actual authenticated CLI.
$chatRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$chatTurn = $null
$chatThread = $null
Write-Output 'NATIVE_CHAT_READY'
while ($true) {
  $chatLine = [Console]::ReadLine()
  if ($null -eq $chatLine) { break }
  $chatMatch = [regex]::Match($chatLine, '\\[Yard chat, topic ([1-7]), turn ([A-Za-z0-9_-]+)\\]')
  if ($chatMatch.Success) {
    $chatThread = [int]$chatMatch.Groups[1].Value
    $chatTurn = $chatMatch.Groups[2].Value
    @{ thread = $chatThread; turn = $chatTurn } | ConvertTo-Json |
      Set-Content -LiteralPath (Join-Path $chatRoot 'received-chat.json') -Encoding utf8
  }
  if ($chatLine.StartsWith('REPLY ') -and $chatTurn) {
    & $env:YARD_CLI chat reply --thread $chatThread --turn $chatTurn --file $chatLine.Substring(6).Trim() |
      Set-Content -LiteralPath (Join-Path $chatRoot 'reply-result.txt') -Encoding utf8
  }
}
`;

async function exerciseChat(page, dir, assertAlive, timeoutMs) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const wait = async (label, read) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const transcript = async () => {
    const prefs = await invoke("read_prefs");
    return prefs["chat.terminal.native-chat"] ? JSON.parse(prefs["chat.terminal.native-chat"]) : null;
  };
  const fixture = join(dir, "chat-agent.ps1");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(fixture, FIXTURE);
  const snapshot = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: snapshot.rev, projects: [],
    groups: [{ id: "chat-board", projectId: null, name: "Native chat check", layoutJson: JSON.stringify({ surface: "canvas", canvas: {
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: { "native-chat": { x: 45, y: 45, w: 800, h: 650 } }, items: [],
    } }) }], terminals: [{ id: "native-chat", groupId: "chat-board", title: "Native chat fixture", kind: "agent", agentId: "claude", surface: "canvas",
      program: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture], cwd: home, createdAt: Date.now() }],
  } })).accepted);
  await page.reload();
  await page.getByRole("button", { name: "Pular", exact: true }).click();
  await wait("chat fixture starts", async () => {
    const probe = await invoke("pty_read_since", { id: "native-chat", after: 0, maxBytes: 1024 });
    if (probe.alive && probe.data.includes("NATIVE_CHAT_READY")) return true;
    const start = page.locator(".pane-exit-banner").getByRole("button", { name: "Começar do zero", exact: true });
    if (await start.isVisible()) await start.click();
    return false;
  });
  await page.getByRole("button", { name: "Mostrar conversa", exact: true }).click();
  await page.getByRole("tab", { name: "Tópico 5", exact: true }).click();
  await page.getByRole("button", { name: "Renomear tópico", exact: true }).click();
  await page.getByRole("textbox", { name: "Nome do tópico", exact: true }).fill("Release checks");
  await page.locator(".cv-chat-rename").getByRole("button", { name: "Salvar", exact: true }).click();
  await page.getByRole("tab", { name: "Release checks", exact: true }).waitFor();
  await invoke("task_create", { input: { id: "native-chat-task", title: "Native release review", request: "Review the native chat fixture", criteria: ["A matching final chat reply is retained"],
    links: { projectId: null, terminalIds: ["native-chat"] } } });
  await invoke("task_create", { input: { id: "other-chat-task", title: "Unassigned private task", request: "Unrelated work", criteria: [],
    links: { projectId: null, terminalIds: ["other-terminal"] } } });
  await page.getByRole("button", { name: "Associar tarefa", exact: true }).click();
  const taskPicker = page.getByRole("combobox", { name: "Tarefa deste tópico", exact: true });
  await taskPicker.locator('option[value="native-chat-task"]').waitFor({ state: "attached" });
  assert.equal(await taskPicker.locator('option[value="other-chat-task"]').count(), 0);
  await taskPicker.selectOption("native-chat-task");
  await page.locator(".cv-chat-task-picker").getByRole("button", { name: "Salvar", exact: true }).click();
  await page.getByText("Tarefa associada: Native release review", { exact: true }).waitFor();
  assert.equal((await invoke("task_get", { id: "native-chat-task" })).status, "draft");
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Tarefas e entregas");
  await page.getByRole("option").filter({ hasText: "Tarefas e entregas" }).click();
  const work = page.getByRole("dialog", { name: "Tarefas e entregas", exact: true });
  await work.locator(".work-task").filter({ hasText: "Native release review" }).click();
  await work.getByRole("button", { name: "Native chat fixture, Release checks: 0 mensagem(ns)", exact: true }).click();
  await page.getByRole("tab", { name: "Release checks", exact: true }).waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "Release checks", exact: true }).waitFor();
  await wait("native fixture is ready for user input", async () => {
    const activity = await invoke("pty_activity", { id: "native-chat" });
    return activity && Date.now() - activity.lastByteAt >= 5000;
  });
  const request = "Review the release fixture and retain this original request.";
  await page.getByRole("textbox", { name: "Mensagem para o agente", exact: true }).fill(request);
  await page.getByRole("button", { name: "Enviar mensagem", exact: true }).click();
  const received = await wait("real CLI fixture receives the selected topic identity", () => {
    try { return JSON.parse(readFileSync(join(dir, "received-chat.json"), "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
  });
  assert.equal(received.thread, 5);
  assert.equal((await transcript()).pending.id, received.turn);
  const response = "**Native response verified.**\n\nThe request and topic identity are preserved.";
  const responsePath = join(dir, "response.md");
  writeFileSync(responsePath, response);
  await invoke("write_pty", { id: "native-chat", data: `REPLY ${responsePath}\r` });
  await wait("authenticated CLI reply completes the exact turn", async () => {
    const document = await transcript();
    return document && !document.pending && document.threads[4].messages.length === 2;
  });
  await page.locator('.cv-chat-message[data-role="assistant"]').getByText("Native response verified.", { exact: true }).waitFor();
  const completed = await transcript();
  assert.equal(completed.threads[4].messages[0].text, request);
  assert.equal(completed.threads[4].messages[1].text, response);
  assert.equal(completed.threads[4].messages[1].id, `${received.turn}:reply`);
  assert.equal(completed.threads[4].taskId, "native-chat-task");
  assert(completed.threads[4].messages.every((message) => message.taskId === "native-chat-task"));
  assert.equal((await invoke("task_get", { id: "native-chat-task" })).status, "draft");
  for (const extension of ["json", "md"]) {
    const destination = join(dir, `conversation.${extension}`);
    // Only the unsupported native file picker is substituted; the UI export and disk write are real.
    await page.evaluate((destination) => {
      const original = window.fetch.bind(window);
      const pickerUrl = window.__TAURI_INTERNALS__.convertFileSrc("plugin:dialog|save", "ipc");
      const replacement = (input, init) => String(input) === pickerUrl
        ? Promise.resolve(new Response(JSON.stringify(destination), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } }))
        : original(input, init);
      window.fetch = replacement;
      if (window.fetch !== replacement) throw new Error("Native save-picker substitution was not applied");
    }, destination);
    await page.getByRole("button", { name: "Exportar tópico", exact: true }).click();
    await wait(`native ${extension} topic export reaches disk`, () => existsSync(destination));
    const exported = readFileSync(destination, "utf8");
    if (extension === "json") {
      const document = JSON.parse(exported);
      assert.equal(document.thread, 5);
      assert.equal(document.topic.name, "Release checks");
      assert.deepEqual(document.topic.messages, completed.threads[4].messages);
    } else { assert(exported.includes(request)); assert(exported.includes(response)); }
  }
  await page.reload();
  await page.getByRole("tab", { name: "Release checks", exact: true }).waitFor();
  assert.deepEqual((await transcript()).threads[4].messages, completed.threads[4].messages);
  await wait("fixture is quiet before the interrupted request", async () => {
    const activity = await invoke("pty_activity", { id: "native-chat" });
    return activity && Date.now() - activity.lastByteAt >= 5000;
  });
  const interruptedRequest = "This pending request requires explicit review after process loss.";
  await page.getByRole("textbox", { name: "Mensagem para o agente", exact: true }).fill(interruptedRequest);
  await page.getByRole("button", { name: "Enviar mensagem", exact: true }).click();
  await wait("second request is reserved", async () => (await transcript())?.pending?.delivery === "waiting");
  await invoke("kill_pty", { id: "native-chat" });
  await page.getByRole("button", { name: "Revisar envio pendente", exact: true }).waitFor();
  assert.equal((await transcript()).pending.delivery, "uncertain");
  await page.getByRole("button", { name: "Revisar envio pendente", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Revisar envio pendente", exact: true });
  await review.getByRole("button", { name: "Cancelar", exact: true }).click();
  assert((await transcript()).pending);
  await page.reload();
  await page.getByRole("button", { name: "Revisar envio pendente", exact: true }).click();
  await review.getByRole("button", { name: "Já conferi, liberar", exact: true }).click();
  await wait("review releases the pending reservation without replay", async () => !(await transcript()).pending);
  await page.getByRole("textbox", { name: "Mensagem para o agente", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Mensagem para o agente", exact: true }).inputValue(), interruptedRequest);
  assert.equal((await invoke("pty_read_since", { id: "native-chat", after: 0, maxBytes: 1 })).alive, false);
  assert.equal((await transcript()).threads[4].messages.length, 3);
  await wait("recovered draft reaches durable storage", async () => (await transcript()).threads[4].draft === interruptedRequest);
  await page.reload();
  await page.getByRole("tab", { name: "Release checks", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Mensagem para o agente", exact: true }).inputValue(), interruptedRequest);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(dir, "chat-recovered.png") });
  const field = page.getByRole("textbox", { name: "Mensagem para o agente", exact: true });
  const draftStyle = await field.evaluate((element) => {
    const style = getComputedStyle(element);
    return { value: element.value, color: style.color, fill: style.webkitTextFillColor, opacity: style.opacity, font: style.font };
  });
  writeFileSync(join(dir, "draft-style.json"), JSON.stringify(draftStyle, null, 2));
  assert.equal(draftStyle.value, interruptedRequest);
  const screenshot = join(tmpdir(), `yard-reviewed-chat-${Date.now()}.png`);
  copyFileSync(join(dir, "chat-recovered.png"), screenshot);
  assert.deepEqual(errors, []);
  return { chat: true, renamedTopic: true, actualCliReply: true, jsonAndMarkdownExport: true, reloadPersistence: true,
    interruptedDelivery: true, reviewedDraft: true, noAutomaticReplay: true, assignedTaskContext: true, taskConversationNavigation: true, taskStatusPreserved: true, screenshot, draftStyle };
}

export function runNativeChatCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseChat, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeChatCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
