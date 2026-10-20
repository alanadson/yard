/** Task evidence and snapshot failures must remain reviewable after a real renderer reload. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseEvidence(page, directory, assertAlive, timeoutMs) {
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const root = join(directory, "repo");
  mkdirSync(root);
  assert.equal(spawnSync("git", ["init", root], { windowsHide: true }).status, 0);
  writeFileSync(join(root, "code.txt"), "original\n");
  const oversized = join(root, "oversized.bin");
  const handle = openSync(oversized, "w");
  closeSync(handle);
  truncateSync(oversized, 32 * 1024 * 1024 + 1);
  const fixture = join(directory, "evidence-agent.ps1");
  const delivered = join(directory, "delivered.txt");
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(fixture, `[Console]::WriteLine('EVIDENCE_READY')
while ($true) {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { break }
  if ($line.Contains('[Yard task evidence-work]')) { [IO.File]::WriteAllText(${quote(delivered)}, $line) }
}
`);
  const workspace = await invoke("load_workspace");
  await invoke("write_pref", { key: "onboarding.done", value: "1" });
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "evidence-project", name: "Evidence check", path: root, createdAt: 1000 }],
    groups: [{ id: "evidence-front", projectId: "evidence-project", name: "Evidence front", layoutJson: "{}" }],
    terminals: [{ id: "evidence-agent", groupId: "evidence-front", title: "Evidence agent", kind: "agent", surface: "grid", program: "powershell.exe", args: ["-NoProfile", "-File", fixture], cwd: root, createdAt: 1000 }] } })).accepted);
  await invoke("spawn_pty", { opts: { id: "evidence-agent", kind: "agent", program: "powershell.exe", args: ["-NoProfile", "-File", fixture], cwd: root, rows: 24, cols: 80, env: [], keepScrollback: false } });
  async function until(read) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Task evidence did not reach its expected state");
  }
  let answered = 0;
  await until(async () => {
    const attached = await invoke("attach_pty", { id: "evidence-agent" });
    const count = attached.data.split("\u001b[6n").length - 1;
    while (answered < count) { await invoke("write_pty", { id: "evidence-agent", data: "\u001b[1;1R" }); answered++; }
    return attached.data.includes("EVIDENCE_READY");
  });
  const task = await invoke("task_create", { input: { id: "evidence-work", title: "Review snapshot evidence", request: "Preserve the recovery evidence", criteria: ["Keep the original bytes"], links: { projectId: "evidence-project", terminalIds: [] } } });
  await invoke("task_enqueue", { id: task.id, revision: task.revision, terminalId: "evidence-agent", queueId: "evidence-attempt" });
  const originalUrl = page.url();
  await page.goto("about:blank");
  await until(() => existsSync(delivered));
  assert(readFileSync(delivered, "utf8").includes("[Yard task evidence-work]"));
  await page.goto(originalUrl);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.getByText(/sem checkpoint/).first().waitFor();
  if (process.env.YARD_NATIVE_SCREENSHOT_DIR) {
    mkdirSync(process.env.YARD_NATIVE_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.YARD_NATIVE_SCREENSHOT_DIR, "checkpoint-warning.png") });
  }
  const history = await until(async () => { const rows = await invoke("checkpoint_notice_history"); return rows.length ? rows : null; });
  assert(history.some((notice) => notice.root === root && notice.reason.includes("32 MiB")));
  assert((await invoke("task_events", { id: task.id })).some((event) => event.kind === "checkpoint_failed"));
  unlinkSync(oversized);
  const checkpoint = await invoke("checkpoint_create", { root, taskId: task.id, taskLabel: task.title, label: "Before evidence review" });
  const linked = await invoke("task_get", { id: task.id });
  assert(linked.links.resources.some((resource) => resource.kind === "checkpoint" && resource.id === checkpoint.id));
  writeFileSync(join(root, "code.txt"), "changed\n");
  await page.reload();
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Tarefas e entregas");
  await page.getByRole("option").filter({ hasText: "Tarefas e entregas" }).click();
  const dialog = page.getByRole("dialog", { name: "Tarefas e entregas", exact: true });
  await dialog.getByRole("button").filter({ hasText: task.title }).click();
  await dialog.getByRole("button", { name: "Before evidence review", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Checkpoints de código", exact: true });
  await manager.waitFor();
  await manager.getByText("code.txt", { exact: true }).waitFor();
  if (process.env.YARD_NATIVE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.YARD_NATIVE_SCREENSHOT_DIR, "task-checkpoint.png") });
  assert((await invoke("checkpoint_notice_history")).length > 0);
  return { deliveryWithoutRenderer: true, failureVisibleAfterReload: true, durableFailureHistory: true, checkpointLinkedToTask: true, reviewOpenedFromTask: true };
}

export function runNativeTaskEvidenceCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseEvidence, options); }
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runNativeTaskEvidenceCheck(process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe"))
    .then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
