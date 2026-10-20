/** Guard stopped-history retention in the real WebView without starting any user agent. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseTerminalMemory(page, directory) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args },
  );
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(directory, "scrollback"), { recursive: true });
  const terminals = Array.from({ length: 12 }, (_, index) => ({
    id: `memory-${index}`, groupId: "memory-group", slot: 0, sort: index, surface: "grid",
    title: `Memory terminal ${index + 1}`, kind: "shell", program: "powershell.exe", args: ["-NoProfile"],
    cwd: home, alive: false, createdAt: 1000 + index,
  }));
  for (const terminal of terminals) {
    writeFileSync(join(directory, "scrollback", `${terminal.id}.bin`),
      `${"Previous output\r\n".repeat(20000)}HISTORY_${terminal.id}\r\n`);
  }
  const current = await invoke("load_workspace");
  const snapshot = {
    rev: current.rev,
    projects: [{ id: "memory-project", name: "Memory check", path: home, createdAt: 1000 }],
    groups: [{ id: "memory-group", projectId: "memory-project", name: "Memory group",
      layoutJson: JSON.stringify({ mode: "auto", surface: "grid", panelCount: 1, activeBySlot: { 0: "memory-0" } }) }],
    terminals,
  };
  assert((await invoke("save_workspace", { snapshot })).accepted);
  // The accessible terminal rows expose the same parsed buffer the canvas paints.
  await invoke("write_pref", { key: "termScreenReader", value: "true" });
  await page.reload();
  const history = (id) => page.locator(`#panel-${id} .xterm-accessibility-tree`).getByText(`HISTORY_${id}`);
  await history("memory-0").waitFor();
  assert.equal(await page.locator(".xterm").count(), 1, "unopened stopped tabs must not allocate terminal buffers");
  for (let index = 1; index < terminals.length; index += 1) {
    await page.locator(`#tab-memory-${index}`).click();
    await history(`memory-${index}`).waitFor();
    assert.equal(await page.locator(".xterm").count(), 2, "only the two most recent stopped histories stay warm");
  }
  assert.equal(await page.locator("#panel-memory-0 .xterm").count(), 0);
  await page.locator("#tab-memory-0").click();
  await history("memory-0").waitFor();
  assert.equal(await page.locator(".xterm").count(), 2);
  assert.equal((await invoke("list_ptys")).length, 0, "reading stopped history must not start a shell");

  const fixtureArgs = ["-NoProfile", "-Command", "Write-Output 'BACKGROUND_MEMORY_READY'; $null = [Console]::ReadLine()"];
  const updated = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { ...updated, terminals: [...updated.terminals, {
    ...terminals[0], id: "memory-live", title: "Background fixture", sort: 12, alive: false,
    args: fixtureArgs,
  }] } })).accepted);
  await page.reload();
  await history("memory-0").waitFor();
  // Use attach-before-spawn: ConPTY needs xterm to answer its initial DSR query.
  await page.locator("#tab-memory-live").click();
  await page.locator("#panel-memory-live").getByRole("button", { name: "Retomar", exact: true }).click();
  const deadline = Date.now() + 30000;
  let backgroundReady = false;
  while (Date.now() < deadline && !backgroundReady) {
    const result = await invoke("pty_read_since", { id: "memory-live", after: 0, maxBytes: 4096 });
    backgroundReady = result.alive && result.data.includes("BACKGROUND_MEMORY_READY");
    if (!backgroundReady) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(backgroundReady, "inactive live terminal prints its readiness marker");
  const live = (await invoke("list_ptys")).find((terminal) => terminal.id === "memory-live");
  assert(live?.pid, "resuming a previously unopened tab starts its process");
  await page.locator("#tab-memory-0").click();
  await history("memory-0").waitFor();
  await page.reload();
  await history("memory-0").waitFor();
  assert.equal((await invoke("list_ptys")).find((terminal) => terminal.id === "memory-live")?.pid,
    live.pid, "reloading attaches to the existing background process");
  for (const index of [1, 2, 3]) {
    await page.locator(`#tab-memory-${index}`).click();
    await history(`memory-${index}`).waitFor();
    assert.equal(await page.locator("#panel-memory-live .xterm").count(), 1);
    assert.equal(await page.locator(".xterm").count(), 3, "live views do not consume the stopped-history allowance");
  }
  assert.equal((await invoke("list_ptys")).find((terminal) => terminal.id === "memory-live")?.pid, live.pid);
  await invoke("kill_pty", { id: "memory-live" });
  await page.waitForFunction(() => document.querySelectorAll(".xterm").length === 2);
  assert.equal((await invoke("list_ptys")).length, 0);
  assert.deepEqual(errors, []);
  const screenshot = join(tmpdir(), `yard-reviewed-terminal-memory-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  return { unopenedHistoriesDeferred: true, stoppedViewsBounded: true, evictedHistoryRestored: true,
    backgroundAttached: true, liveProcessPreserved: true, screenshot };
}

export function runNativeTerminalMemoryCheck(exe, options = {}) {
  return runNativeAppCheck(exe, exerciseTerminalMemory, options);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "release", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeTerminalMemoryCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
