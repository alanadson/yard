/** Verify agent diagnostics in the native UI while keeping all preferences and browser data isolated. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseDiagnostics(page, dir, assertAlive, timeoutMs) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const wait = async (label, read) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertAlive();
      if (await read()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "diagnostics-project", name: "Native diagnostics", path: home, createdAt: Date.now() }],
    groups: [{ id: "diagnostics-group", projectId: "diagnostics-project", name: "Diagnostics", layoutJson: "{}" }], terminals: [],
  } })).accepted);
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  const agents = await invoke("detect_agents", { refresh: false });
  const claude = agents.find((agent) => agent.id === "claude");
  assert(claude);
  async function settings() {
    await page.locator("body").click({ position: { x: 550, y: 420 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Configurações");
    await page.getByRole("option").filter({ hasText: "Configurações" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true });
    await dialog.getByRole("button", { name: "Agentes", exact: true }).click();
    await dialog.getByRole("tab", { name: "Claude Code", exact: true }).click();
    await dialog.getByRole("table", { name: "Integrações deste agente", exact: true }).waitFor();
    return dialog;
  }
  let dialog = await settings();
  const table = () => dialog.getByRole("table", { name: "Integrações deste agente", exact: true });
  assert.equal(await table().locator("tbody tr").count(), 6);
  for (const key of ["resume", "continue", "transcript", "mcp", "hooks", "usageLimits"]) {
    assert.equal(await table().locator(`[data-capability="${key}"] td`).innerText(), "Integrado");
  }
  if (claude.bin) await dialog.getByText(claude.bin, { exact: true }).waitFor();
  if (claude.version) await dialog.getByText(claude.version, { exact: true }).first().waitFor();
  // A held native discovery failure proves pending and error states without replacing the cached catalog.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const discoveryUrl = window.__TAURI_INTERNALS__.convertFileSrc("detect_agents", "ipc");
    let first = true;
    window.fetch = (input, init) => {
      if (String(input) !== discoveryUrl || !first) return original(input, init);
      first = false;
      return new Promise((resolve) => {
        window.__yardReleaseDiscovery = () => resolve(new Response(JSON.stringify("Controlled discovery failure"),
          { headers: { "Content-Type": "application/json", "Tauri-Response": "error" } }));
      });
    };
  });
  await dialog.getByRole("button", { name: "Atualizar descoberta", exact: true }).click();
  const pending = dialog.getByRole("button", { name: "Verificando agentes…", exact: true });
  await pending.waitFor();
  assert(await pending.isDisabled());
  await page.evaluate(() => window.__yardReleaseDiscovery());
  await dialog.getByRole("alert").filter({ hasText: "Controlled discovery failure" }).waitFor();
  assert.equal(await table().locator("tbody tr").count(), 6);
  if (claude.bin) await dialog.getByText(claude.bin, { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Atualizar descoberta", exact: true }).click();
  await wait("actual native discovery finishes", async () => !(await dialog.getByRole("button", { name: "Atualizar descoberta", exact: true }).isDisabled()));
  await wait("successful discovery clears its error", async () => await dialog.getByRole("alert").count() === 0);
  await invoke("write_pref", { key: "agents.defaults", value: JSON.stringify({ claude: { where: "ssh" } }) });
  await page.reload();
  dialog = await settings();
  await dialog.getByText("Ambiente selecionado: SSH", { exact: true }).waitFor();
  for (const key of ["transcript", "mcp", "hooks", "usageLimits"]) {
    assert.equal(await table().locator(`[data-capability="${key}"] td`).innerText(), "Sem integração neste ambiente");
  }
  assert.equal(await table().locator('[data-capability="resume"] td').innerText(), "Integrado");
  await page.setViewportSize({ width: 760, height: 850 });
  await table().scrollIntoViewIfNeeded();
  await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  const screenshot = join(tmpdir(), `yard-reviewed-diagnostics-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []);
  return { diagnostics: true, nativeCatalog: true, localCapabilityMatrix: true, simulatedFailureRetainsCatalog: true,
    explicitRefreshRecovers: true, restoredRemoteProfile: true, remoteConnectionsVerified: false, screenshot };
}

export function runNativeDiagnosticsCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseDiagnostics, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeDiagnosticsCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
