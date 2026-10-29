/** Independent reviews must travel through the real queue and authenticated CLI. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

const FIXTURE = `Write-Output 'REVIEW_READY'
$reviewId = $null
$reviewAttempt = $null
while ($true) {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { break }
  $match = [regex]::Match($line, '\\[Yard task ([A-Za-z0-9_-]+)\\]')
  if ($match.Success) {
    $reviewId = $match.Groups[1].Value
    $shown = & $env:YARD_CLI task show $reviewId
    $shown | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'received-review.json') -Encoding utf8
    $reviewAttempt = ($shown | ConvertFrom-Json).links.queueItemId
  }
  if ($line.StartsWith('REPORT ') -and $reviewId) {
    & $env:YARD_CLI task submit $reviewId --attempt $reviewAttempt --file $line.Substring(7).Trim() |
      Set-Content -LiteralPath (Join-Path $PSScriptRoot 'review-result.json') -Encoding utf8
  }
}
`;

async function exerciseReviews(page, dir, assertAlive, timeoutMs) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  assert.match(page.url(), /^http:\/\/tauri\.localhost/);
  assert.match(await page.title(), /Yard/);
  assert.equal(await page.locator("vite-error-overlay").count(), 0);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const until = async (read) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Independent review did not reach its expected state");
  };
  const home = join(dir, "project");
  mkdirSync(home);
  writeFileSync(join(home, "proof.md"), "# Independent review proof\n\nThe original delivery remains available.\n");
  const fixture = join(dir, "reviewer.ps1");
  writeFileSync(fixture, FIXTURE);
  const now = Date.now();
  const terminals = ["author", "reviewer"].map((id) => ({ id, groupId: "group", title: id === "author" ? "Author" : "Independent reviewer",
    kind: "agent", agentId: "claude", surface: "grid", program: "powershell.exe",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fixture], cwd: home, createdAt: now }));
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "project", name: "Review check", path: home, createdAt: now }],
    groups: [{ id: "group", projectId: "project", name: "Review", layoutJson: "{}" }], terminals } })).accepted);
  await page.reload();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  for (const terminal of terminals) {
    if (!(await invoke("pty_read_since", { id: terminal.id, after: 0, maxBytes: 1 })).alive) {
      await invoke("spawn_pty", { opts: { ...terminal, rows: 24, cols: 100 } });
    }
  }
  let answered = 0;
  await until(async () => {
    const attached = await invoke("attach_pty", { id: "reviewer" });
    const queries = attached.data.split("\u001b[6n").length - 1;
    while (answered < queries) { await invoke("write_pty", { id: "reviewer", data: "\u001b[1;1R" }); answered++; }
    return attached.data.includes("REVIEW_READY");
  });
  let task = await invoke("task_create", { input: { id: "original", title: "Delivery to review", request: "Verify the original API contract",
    criteria: ["Preserve the API contract"], links: { projectId: "project", terminalIds: ["author"], executorTerminalId: "author" } } });
  task = await invoke("task_transition", { id: task.id, revision: task.revision, status: "queued" });
  task = await invoke("task_transition", { id: task.id, revision: task.revision, status: "running" });
  task = await invoke("task_submit", { id: task.id, revision: task.revision, submission: {
    delivery: { summary: "Original delivery", artifacts: ["proof.md"], checks: [{ name: "API", passed: true, evidence: "proof.md" }] }, evidence: { "criterion-1": ["proof.md"] } } });
  async function panel() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Tarefas e entregas");
    await page.getByRole("option").filter({ hasText: "Tarefas e entregas" }).click();
    const dialog = page.getByRole("dialog", { name: "Tarefas e entregas", exact: true });
    await dialog.getByRole("button").filter({ has: page.getByText("Delivery to review", { exact: true }) }).click();
    return dialog;
  }
  let dialog = await panel();
  await dialog.getByLabel("Agente revisor", { exact: true }).selectOption("reviewer");
  assert.equal(await dialog.getByLabel("Agente revisor", { exact: true }).locator('option[value="author"]').count(), 0);
  await dialog.getByRole("button", { name: "Solicitar revisão independente", exact: true }).click();
  await until(() => existsSync(join(dir, "received-review.json")));
  const received = JSON.parse(readFileSync(join(dir, "received-review.json"), "utf8").replace(/^\uFEFF/, ""));
  assert(received.request.includes("Original delivery"));
  assert(received.request.includes(home.replaceAll("\\", "\\\\")));
  const report = join(dir, "report.json");
  writeFileSync(report, JSON.stringify({ delivery: { summary: "Independent finding: missing edge case", artifacts: ["proof.md"],
    checks: [{ name: "Edge case", passed: false, evidence: "proof.md" }] }, evidence: { "criterion-1": ["proof.md"] } }));
  await invoke("write_pty", { id: "reviewer", data: `REPORT ${report}\r` });
  await dialog.getByText("Precisa de ajustes", { exact: true }).waitFor();
  await dialog.getByText("Independent finding: missing edge case", { exact: true }).waitFor();
  assert.equal((await invoke("task_get", { id: task.id })).status, "in_review");
  await page.reload();
  dialog = await panel();
  await dialog.getByText("Independent finding: missing edge case", { exact: true }).waitFor();
  const screenshotDir = process.env.YARD_NATIVE_SCREENSHOT_DIR;
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true });
    await dialog.getByText("Independent finding: missing edge case", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshotDir, "independent-review.png") });
    await page.setViewportSize({ width: 900, height: 780 });
    await dialog.getByText("Precisa de ajustes", { exact: true }).waitFor();
    await dialog.getByText("Independent finding: missing edge case", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshotDir, "independent-review-compact.png") });
  }
  await dialog.getByRole("button", { name: "Abrir artefato: proof.md", exact: true }).first().click();
  await page.getByText("Independent review proof", { exact: false }).first().waitFor();
  assert.deepEqual(errors, []);
  return { authorExcluded: true, realQueueAndCli: true, snapshotPreserved: true, findingsPersisted: true, humanApprovalPreserved: true, artifactOpened: true, consoleErrors: errors.length };
}

export function runNativeReviewsCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseReviews, options); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runNativeReviewsCheck(process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe"))
    .then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
