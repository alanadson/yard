/** Compare native session and history estimates with the displayed cache-duration totals. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNativeAppCheck } from "./native-work.mjs";

async function exerciseCosts(page, dir) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__);
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const home = join(dir, "home");
  const sessions = join(home, ".claude", "projects", "native-costs");
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, "session.jsonl");
  const line = JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), cwd: home,
    message: { id: "native-cache-request", model: "claude-sonnet-4-5", usage: {
      cache_creation_input_tokens: 2000000, cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 },
    } } });
  writeFileSync(file, `${line}\n${line}\n`);
  const workspace = await invoke("load_workspace");
  assert((await invoke("save_workspace", { snapshot: { rev: workspace.rev,
    projects: [{ id: "costs-project", name: "Native costs", path: home, createdAt: Date.now() }],
    groups: [{ id: "costs-group", projectId: "costs-project", name: "Costs", layoutJson: "{}" }], terminals: [],
  } })).accepted);
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  const session = await invoke("get_session_usage", { file });
  assert.equal(session.cacheCreationTokens, 2000000);
  assert.equal(session.cacheCreationOneHourTokens, 1000000);
  assert.equal(session.costUsd, 9.75);
  const reference = await invoke("pricing_reference");
  assert.equal(reference.currency, "USD");
  assert.equal(reference.provider, "anthropic");
  const opus = reference.models.find((model) => model.model === "claude-opus-5-5");
  assert(opus);
  assert.equal(opus.cacheRead, 0.2);
  assert.equal(opus.verifiedOn, "2026-10-06");
  const modelCheckFile = join(dir, "pricing-check.jsonl");
  writeFileSync(modelCheckFile, JSON.stringify({ type: "assistant", message: { id: "price-reference-request", model: opus.model,
    usage: { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000 } } }));
  assert.equal((await invoke("get_session_usage", { file: modelCheckFile })).costUsd, opus.input + opus.output + opus.cacheRead);
  const history = await invoke("usage_history", { days: 1 });
  assert.equal(history.length, 1);
  assert.equal(history[0].cacheWrite, 2000000);
  assert.equal(history[0].cacheWriteOneHour, 1000000);
  assert.equal(history[0].costUsd, session.costUsd);
  async function panel() {
    await page.keyboard.press("Control+p");
    await page.getByRole("combobox").fill("Custos e uso");
    await page.getByRole("option").filter({ hasText: "Custos e uso" }).click();
    const dialog = page.getByRole("dialog", { name: "Custos e uso", exact: true });
    await dialog.waitFor();
    await dialog.getByText("1 h informado: 1,0 mi", { exact: true }).waitFor();
    assert((await dialog.locator(".costs-tile--main strong").innerText()).includes("9,75"));
    return dialog;
  }
  let dialog = await panel();
  await dialog.getByRole("button", { name: "Referência de preços", exact: true }).click();
  const pricing = page.getByRole("dialog", { name: "Referência de preços", exact: true });
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill("OPUS-5-5");
  const rates = pricing.getByRole("region", { name: "claude-opus-5-5", exact: true });
  await rates.waitFor();
  assert.deepEqual(await rates.locator("dd").allTextContents(), ["US$ 4,00", "US$ 20,00", "US$ 0,20", "US$ 5,00", "US$ 8,00"]);
  await rates.getByText("Conferido em 2026-10-06", { exact: true }).waitFor();
  await rates.getByText("https://platform.claude.com/docs/en/about-claude/pricing", { exact: true }).waitFor();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill("claude-3-opus");
  await pricing.getByText("Referência antiga de 2026-08-12, sem nova conferência", { exact: true }).waitFor();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill("opus-99");
  await pricing.getByText("Nenhum modelo encontrado.", { exact: true }).waitFor();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill("5-5");
  await page.setViewportSize({ width: 620, height: 850 });
  await pricing.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  const pricingScreenshot = join(tmpdir(), `yard-reviewed-pricing-${Date.now()}.png`);
  await page.screenshot({ path: pricingScreenshot });
  await page.keyboard.press("Escape");
  await dialog.waitFor();
  await page.setViewportSize({ width: 760, height: 850 });
  await dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  const screenshot = join(tmpdir(), `yard-reviewed-costs-${Date.now()}.png`);
  await page.screenshot({ path: screenshot });
  await page.reload();
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  dialog = await panel();
  assert.equal((await invoke("get_session_usage", { file })).costUsd, session.costUsd);
  assert.equal((await invoke("usage_history", { days: 1 }))[0].costUsd, session.costUsd);
  const settings = await invoke("pricing_settings");
  assert.equal(settings.revision, 0);
  const custom = { model: "claude-sonnet-4-5", input: 1, output: 3, cacheRead: 0.2, cacheWriteFiveMinute: 1.5, cacheWriteOneHour: 2.5 };
  const saved = await invoke("pricing_settings_save", { revision: settings.revision, rates: [custom] });
  assert.equal(saved.revision, 1);
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 4);
  assert.equal((await invoke("usage_history", { days: 1 }))[0].costUsd, 4);
  await assert.rejects(invoke("pricing_settings_save", { revision: settings.revision, rates: [] }), /STALE_PRICING_REVISION/);
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 4);
  await page.reload();
  assert.deepEqual((await invoke("pricing_settings")).rates, [custom]);
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 4);
  await invoke("pricing_settings_save", { revision: saved.revision, rates: [] });
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 9.75);
  await page.getByText("Nenhum terminal neste grupo", { exact: true }).click();
  dialog = await panel();
  await dialog.getByRole("button", { name: "Referência de preços", exact: true }).click();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill(custom.model);
  const customRegion = pricing.getByRole("region", { name: custom.model, exact: true });
  await customRegion.getByRole("button", { name: "Personalizar tarifa", exact: true }).click();
  const editor = pricing.getByRole("form", { name: "Editar tarifa personalizada", exact: true });
  await editor.getByRole("textbox", { name: "Entrada", exact: true }).fill("");
  assert.equal(await editor.getByRole("button", { name: "Salvar tarifas", exact: true }).isEnabled(), false);
  for (const [name, value] of [["Entrada", "1,0"], ["Saída", "3"], ["Cache lido", "0,2"], ["Cache gravado, 5 min", "1,5"], ["Cache gravado, 1 h", "2,5"]]) {
    await editor.getByRole("textbox", { name, exact: true }).fill(value);
  }
  await editor.getByRole("button", { name: "Salvar tarifas", exact: true }).click();
  await customRegion.getByText("Tarifa personalizada salva, revisão 3", { exact: true }).waitFor();
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 4);
  await pricing.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  const customScreenshot = join(tmpdir(), `yard-reviewed-custom-pricing-${Date.now()}.png`);
  await page.screenshot({ path: customScreenshot });
  await customRegion.getByRole("button", { name: "Personalizar tarifa", exact: true }).click();
  await invoke("pricing_settings_save", { revision: 3, rates: [{ ...custom, input: 2 }] });
  await editor.getByRole("button", { name: "Salvar tarifas", exact: true }).click();
  await pricing.getByRole("alert").waitFor();
  assert.equal(await editor.getByRole("textbox", { name: "Entrada", exact: true }).inputValue(), "1");
  assert.equal((await invoke("pricing_settings")).revision, 4);
  await editor.getByRole("button", { name: "Cancelar edição", exact: true }).click();
  await pricing.getByRole("button", { name: "Atualizar", exact: true }).click();
  await customRegion.getByText("Tarifa personalizada salva, revisão 4", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.getByText("1 tarifa(s) personalizada(s) ativa(s).", { exact: true }).waitFor();
  assert((await dialog.locator(".costs-tile--main strong").innerText()).includes("4,00"));
  await dialog.getByRole("button", { name: "Referência de preços", exact: true }).click();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill(custom.model);
  await customRegion.getByRole("button", { name: "Remover tarifa personalizada", exact: true }).click();
  await customRegion.getByText("Conferido em 2026-10-06", { exact: true }).waitFor();
  assert.equal((await invoke("get_session_usage", { file })).costUsd, 9.75);
  await page.keyboard.press("Escape");
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector(".costs-tile--main strong")?.textContent.includes("9,75"));
  const codexDirectory = join(home, ".codex", "sessions", "native-costs");
  mkdirSync(codexDirectory, { recursive: true });
  const codexFile = join(codexDirectory, "rollout.jsonl");
  const timestamp = new Date().toISOString();
  writeFileSync(codexFile, [
    JSON.stringify({ type: "session_meta", timestamp, payload: { cwd: home } }),
    JSON.stringify({ type: "turn_context", timestamp, payload: { model: "custom-codex-model" } }),
    JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count", info: { total_token_usage:
      { input_tokens: 1000000, cached_input_tokens: 500000, output_tokens: 100000 } } } }),
  ].join("\n"));
  await dialog.getByRole("button", { name: "Referência de preços", exact: true }).click();
  await pricing.getByRole("button", { name: "Nova tarifa", exact: true }).click();
  await editor.getByRole("textbox", { name: "Modelo da tarifa", exact: true }).fill("custom-codex-model");
  for (const [name, value] of [["Entrada", "2"], ["Saída", "10"], ["Cache lido", "0,5"], ["Cache gravado, 5 min", "2,5"], ["Cache gravado, 1 h", "4"]]) {
    await editor.getByRole("textbox", { name, exact: true }).fill(value);
  }
  const editorScreenshot = join(tmpdir(), `yard-reviewed-price-editor-${Date.now()}.png`);
  await page.screenshot({ path: editorScreenshot });
  await editor.getByRole("button", { name: "Salvar tarifas", exact: true }).click();
  await pricing.getByRole("textbox", { name: "Buscar modelo" }).fill("custom-codex-model");
  await pricing.getByRole("region", { name: "custom-codex-model", exact: true }).getByText("Tarifa personalizada salva, revisão 6", { exact: true }).waitFor();
  const codexUsage = await invoke("get_session_usage", { file: codexFile });
  assert.equal(codexUsage.inputTokens, 500000);
  assert.equal(codexUsage.cacheReadTokens, 500000);
  assert.equal(codexUsage.costUsd, 2.25);
  const codexHistory = (await invoke("usage_history", { days: 1 })).find((row) => row.agent === "codex");
  assert(codexHistory);
  assert.equal(codexHistory.input, 500000);
  assert.equal(codexHistory.cacheRead, 500000);
  assert.equal(codexHistory.costUsd, codexUsage.costUsd);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".costs-tile--main strong")?.textContent.includes("12,00"));
  appendFileSync(codexFile, `\n${JSON.stringify({ type: "event_msg", timestamp, payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 1000100, cached_input_tokens: 2000000, output_tokens: 100000 } } } })}\n`);
  const invalidCodexUsage = await invoke("get_session_usage", { file: codexFile });
  assert.equal(invalidCodexUsage.cacheReadTokens, 2000000);
  assert.equal(invalidCodexUsage.costUsd, null);
  const invalidCodexHistory = (await invoke("usage_history", { days: 1 })).find((row) => row.agent === "codex");
  assert.equal(invalidCodexHistory.cacheRead, 2000000);
  assert.equal(invalidCodexHistory.costUsd, null);
  await dialog.getByRole("button", { name: "Atualizar", exact: true }).click();
  await page.waitForFunction(() => {
    const total = document.querySelector(".costs-tile--main strong")?.textContent ?? "";
    return total.includes("9,75") && total.includes("≥");
  });
  await dialog.getByText("Registros de tokens inconsistentes também ficam sem estimativa.", { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  return { costs: true, sessionHistoryParity: true, duplicateMessagesCountedOnce: true, oneHourReportedSeparately: true,
    displayedEstimate: true, reloadPersistence: true, priceReferenceParity: true, priceReferenceSearch: true,
    legacyPriceProvenance: true, parentPanelRestored: true, customRatesRepriceCachedUsage: true,
    staleRateSaveRejected: true, customRateReload: true, customRateReset: true, customRateEditor: true,
    staleEditorDraftPreserved: true, codexCustomRates: true, codexCacheNotDoubleCounted: true, invalidCodexUsageStaysUnpriced: true,
    customScreenshot, editorScreenshot, pricingScreenshot, screenshot };
}

export function runNativeCostsCheck(exe, options = {}) { return runNativeAppCheck(exe, exerciseCosts, options); }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const exe = process.argv[2] ?? join("src-tauri", "target", "debug", "yard.exe");
  if (!existsSync(exe)) { console.error(`Executable not found: ${exe}`); process.exitCode = 2; }
  else runNativeCostsCheck(exe).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
