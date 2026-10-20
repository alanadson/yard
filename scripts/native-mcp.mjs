/** Verify native MCP configuration writes keep their original project across delayed acknowledgements. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseMcp(page, directory) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const roots = [join(directory, "home", "a"), join(directory, "home", "b")];
  const fixture = join(directory, "owned-mcp-server.mjs");
  writeFileSync(fixture, `import { createInterface } from "node:readline";
if (process.env.FIXTURE_SECRET !== "owned-native-secret-do-not-render") process.exit(5);
const input = createInterface({ input: process.stdin });
let initialized = false;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") { initialized = true; return; }
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "native-owned-mcp", version: "1.2.3" } }
    : initialized && message.method === "tools/list"
      ? { tools: [{ name: "inspect", inputSchema: { type: "object" } }] } : null;
  if (result) console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
`);
  for (const [index, root] of roots.entries()) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      [index === 0 ? "a-server" : "b-server"]: { command: "node", args: index === 0 ? ["--version"] : [fixture], env: index === 0 ? { FIXTURE_OWNER: "A" } : { FIXTURE_OWNER: "B", FIXTURE_SECRET: "owned-native-secret-do-not-render" } },
    } }));
  }
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: roots.map((path, index) => ({ id: `mcp-project-${index}`, name: index === 0 ? "MCP A" : "MCP B", path, createdAt: Date.now() })),
    groups: roots.map((_path, index) => ({ id: `mcp-group-${index}`, projectId: `mcp-project-${index}`, name: index === 0 ? "Group A" : "Group B", layoutJson: "{}" })), terminals: [],
  } })).accepted);
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  async function settings() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Configurações");
    await page.getByRole("option").filter({ hasText: "Configurações" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Configurações", exact: true });
    await dialog.getByRole("button", { name: "Servidores MCP", exact: true }).click();
    return dialog;
  }
  let dialog = await settings();
  await dialog.locator(".set-mcp-row").filter({ hasText: "a-server" }).getByRole("button", { name: "Editar", exact: true }).click();
  await dialog.locator('.set-mcp-form input[placeholder="ex.: npx"]').fill("node-updated-fixture");
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const url = window.__TAURI_INTERNALS__.convertFileSrc("mcp_save", "ipc");
    let first = true;
    window.fetch = (input, init) => {
      if (String(input) !== url || !first) return original(input, init);
      first = false;
      return original(input, init).then((response) => new Promise((resolve) => { window.__yardReleaseMcpSave = () => resolve(response); }));
    };
  });
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  await dialog.getByRole("button", { name: "Salvando…", exact: true }).waitFor();
  await page.waitForFunction(() => !!window.__yardReleaseMcpSave);
  const written = JSON.parse(readFileSync(join(roots[0], ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers["a-server"].command, "node-updated-fixture");
  assert.equal(written.mcpServers["a-server"].env.FIXTURE_OWNER, "A");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.keyboard.press("Control+p");
  await page.getByRole("combobox").fill("Group B");
  await page.getByRole("option").filter({ hasText: "Group B" }).first().click();
  dialog = await settings();
  await dialog.locator(".set-mcp-row").filter({ hasText: "b-server" }).waitFor();
  await page.evaluate(() => window.__yardReleaseMcpSave());
  await page.getByText("“a-server” atualizado.", { exact: true }).waitFor();
  await dialog.locator(".set-mcp-row").filter({ hasText: "b-server" }).waitFor();
  assert.equal(await dialog.locator(".set-mcp-row").filter({ hasText: "a-server" }).count(), 0);
  assert.equal(JSON.parse(readFileSync(join(roots[1], ".mcp.json"), "utf8")).mcpServers["b-server"].command, "node");
  const selected = dialog.locator(".set-mcp-row").filter({ hasText: "b-server" });
  await selected.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await selected.getByText("Conectado: native-owned-mcp 1.2.3, 1 ferramenta.", { exact: true }).waitFor();
  assert.equal((await dialog.innerText()).includes("owned-native-secret-do-not-render"), false);
  assert.deepEqual(errors, []);
  const screenshot = join(tmpdir(), `yard-reviewed-mcp-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  await page.setViewportSize({ width: 640, height: 800 });
  assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), "MCP settings must fit the narrow viewport");
  assert(await selected.locator(".set-row-text").evaluate((element) => element.clientWidth >= 200), "server details must retain a readable width");
  assert(await selected.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [...element.querySelectorAll("button")].every((button) => button.getBoundingClientRect().right <= bounds.right);
  }), "server actions must remain inside their row");
  const narrowScreenshot = join(tmpdir(), `yard-reviewed-mcp-narrow-${Date.now()}.png`);
  await page.screenshot({ path: narrowScreenshot });
  return { nativeConfigurationWrite: true, capturedSecretsPreserved: true, otherProjectFilePreserved: true, delayedSaveKeepsSelectedProject: true, realStdioHandshake: true, secretsAbsentFromDiagnostics: true, screenshot, narrowScreenshot };
}

export function runNativeMcpCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseMcp, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeMcpCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
