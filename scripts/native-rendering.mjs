/** Verify gated diagram and formula rendering through the native Markdown reader. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

const MARKDOWN = "# Native rendering check\n\n```mermaid\nflowchart LR\n A[Ready] --> B[Delivered]\n```\n\n```math\nc^2 = a^2 + b^2\n```\n\n```mermaid\ninvalid diagram syntax retained as code\n```\n";

async function exerciseRendering(page, directory) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const root = join(directory, "home");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "rendering.md"), MARKDOWN);
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "render-project", name: "Native rendering", path: root, createdAt: Date.now() }],
    groups: [{ id: "render-group", projectId: "render-project", name: "Rendering", layoutJson: "{}" }], terminals: [],
  } })).accepted);
  await invoke("write_pref", { key: "editor.mdMode", value: "read" });
  async function openMarkdown() {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("/rendering.md");
    await page.getByRole("option").filter({ hasText: "rendering.md" }).first().click();
    await page.getByRole("heading", { name: "Native rendering check", exact: true }).waitFor();
  }
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  await openMarkdown();
  assert.equal(await page.locator(".md-mermaid").count(), 0);
  assert.equal(await page.locator(".md-katex").count(), 0);
  await page.locator("pre").filter({ hasText: "A[Ready]" }).waitFor();
  await invoke("write_pref", { key: "ext.enabled", value: JSON.stringify({ mermaid: true, katex: true }) });
  await page.reload();
  await openMarkdown();
  await page.locator(".md-mermaid svg").waitFor();
  await page.locator(".md-katex math").waitFor();
  assert.equal(await page.locator(".md-mermaid svg").count(), 1);
  assert.equal(await page.locator(".md-katex math").count(), 1);
  await page.locator(".md-mermaid").getByText("Delivered", { exact: true }).waitFor();
  await page.locator("pre").filter({ hasText: "invalid diagram syntax retained as code" }).waitFor();
  const bounds = await page.locator(".md-katex").boundingBox();
  assert(bounds && bounds.width > 0 && bounds.height > 0);
  assert.deepEqual(errors, []);
  const screenshot = join(tmpdir(), `yard-reviewed-rendering-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  return { extensionGating: true, nativeMarkdown: true, diagram: true, formula: true, invalidDiagramFallback: true, screenshot };
}

export function runNativeRenderingCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseRendering, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeRenderingCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
