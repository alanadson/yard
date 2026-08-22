/** Portal automation commands exposed by the `yard` bridge CLI. */
import { nanoid } from "nanoid";

import { bridgeCallerRect, commitBridgeCanvas } from "./bridgeCanvas";
import {
  connectedPortals,
  findPortal,
  makeCtx,
  parseFlags,
  type Ctx,
} from "./bridgeCore";
import { PORTAL_DEFAULT_H, PORTAL_DEFAULT_W } from "./canvas";
import {
  addItems,
  connection,
  patchItemOfType,
  removeItemAndEdges,
} from "./canvasOps";
import { ipc, type BridgeResponse } from "./ipc";
import {
  checkJs,
  clickJs,
  fillJs,
  focusJs,
  hoverJs,
  HTML_JS,
  INFO_JS,
  keyJs,
  LOGS_JS,
  LOGS_START_JS,
  scrollIntoViewJs,
  scrollJs,
  selectJs,
  SNAPSHOT_JS,
  textJs,
  typeJs,
} from "./portalDriver";
import {
  isSupportedPortalUrl,
  normalizePortalUrl,
  portalName,
  resolveUa,
  UA_PRESET_IDS,
} from "./portals";
import { openPortalEngine, type PortalSpawn } from "./portalSpawn";
import { useProjects } from "../stores/projectsStore";

const ok = (output: string): BridgeResponse => ({ code: 0, output });
const err = (output: string): BridgeResponse => ({ code: 1, output });
const callerRect = bridgeCallerRect;
const commitCanvas = commitBridgeCanvas;
// --- portal -----------------------------------------------------------------

function portalMiss(ctx: Ctx, name?: string): string {
  const names = connectedPortals(ctx).map(
    (p) => `"${ctx.portalNameOf.get(p.id)}"`,
  );
  return (
    `yard: portal "${name ?? ""}" nao esta conectado a voce.` +
    (names.length
      ? ` Disponiveis: ${names.join(", ")}.`
      : " Nenhum portal conectado.") +
    "\n"
  );
}

/**
 * The engine defaults live in `portalSpawn` so a portal created by the CLI and
 * one created from the UI are the same object.
 */
async function ensurePortalOpen(p: PortalSpawn): Promise<void> {
  await openPortalEngine(p);
}

async function evalPortal(id: string, js: string): Promise<string> {
  return ipc.portalEval(id, js);
}

export async function cmdPortal(
  ctx: Ctx,
  args: string[],
): Promise<BridgeResponse> {
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1);

  if (sub === "create") {
    const p = parseFlags(rest, {
      "--engine": "string",
      "--ua": "string",
      "--size": "string",
    });
    // Every portal runs in WebView2. `--engine` announced a choice of browser
    // engine and only ever set the UA string — so an agent asking for Firefox
    // to reproduce a compatibility bug tested Chromium and reported that it
    // did not reproduce. `--ua` is the honest name; `--engine` stays as an
    // alias for the calls already written, and says what it really does.
    const requestedUa = p.string.ua ?? p.string.engine;
    let size: { w: number; h: number } | undefined;
    if (p.string.size != null) {
      const m = p.string.size.match(/^(\d+)x(\d+)$/i);
      if (!m) return err("yard: --size espera WxH (ex.: 390x844)\n");
      size = { w: Number(m[1]), h: Number(m[2]) };
    }
    const urlRaw = p.positional[0];
    if (!urlRaw) {
      return err(
        'uso: yard portal create URL ["Nome"] [--ua chrome|firefox|ios|…] [--size WxH]\n' +
          "     (a página roda sempre no WebView2; --ua só troca o user-agent)\n",
      );
    }
    if (!isSupportedPortalUrl(urlRaw)) {
      return err(
        "yard: um portal abre páginas http/https (ou about:blank). " +
          `"${urlRaw}" não é um endereço que ele sirva.\n`,
      );
    }
    const href = normalizePortalUrl(urlRaw);
    const name = p.positional[1];
    const id = nanoid(8);
    const base = callerRect(ctx);
    const uaFromEngine =
      requestedUa && requestedUa !== "webview2" ? resolveUa(requestedUa) : undefined;
    const item = {
      id,
      type: "portal" as const,
      x: base.x + base.w + 48,
      y: base.y + connectedPortals(ctx).length * 28,
      w: size?.w ?? PORTAL_DEFAULT_W,
      h: size?.h ?? PORTAL_DEFAULT_H,
      url: href,
      color: "#f5f5f5",
      engine: "webview2",
      ...(uaFromEngine ? { ua: uaFromEngine } : {}),
      ...(name ? { name } : {}),
    };
    commitCanvas(ctx.groupId, (c) =>
      addItems(c, item, connection(ctx.caller.id, id)),
    );
    try {
      await ensurePortalOpen({ ...item, groupId: ctx.groupId });
    } catch (e) {
      return err(`yard: portal criado no canvas, mas o motor falhou: ${e}\n`);
    }
    const fresh = makeCtx(
      ctx.caller,
      ctx.groupId,
      useProjects.getState().layoutOf(ctx.groupId).canvas ?? ctx.canvas,
      ctx.terminals,
    );
    // A bare word that is not a preset ("brave", "safari") would be stored as
    // the literal UA string — technically valid, certainly not what was meant.
    const unknown =
      requestedUa &&
      requestedUa !== "webview2" &&
      !requestedUa.includes(" ") &&
      !UA_PRESET_IDS.includes(
        requestedUa.trim().toLowerCase() as (typeof UA_PRESET_IDS)[number],
      );
    const notice = unknown
      ? ` — atenção: "${requestedUa}" não é um preset de UA (${UA_PRESET_IDS.join(", ")}) ` +
        "e virou a string de user-agent literal. Todo portal roda no WebView2."
      : "";
    return ok(
      `Portal criado e conectado: "${fresh.portalNameOf.get(id) ?? name ?? portalName(item)}"` +
        `${notice}\n`,
    );
  }

  if (sub === "close") {
    const name = rest[0];
    if (!name) return err('uso: yard portal close "Nome"\n');
    const p = findPortal(ctx, name);
    if (!p) return err(portalMiss(ctx, name));
    void ipc.portalClose(p.id).catch(() => {});
    commitCanvas(ctx.groupId, (c) => removeItemAndEdges(c, p.id));
    return ok(`Portal "${ctx.portalNameOf.get(p.id)}" removido.\n`);
  }

  if (sub === "edit") {
    const name = rest[0];
    let url: string | undefined;
    /** `--live on|off`: reload by itself when the site changes. */
    let live: boolean | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--url") url = rest[++i];
      else if (rest[i] === "--live") live = rest[++i] !== "off";
      else if (!url) url = rest[i];
    }
    if (!name || (!url && live === undefined)) {
      return err('uso: yard portal edit "Nome" [--url URL] [--live on|off]\n');
    }
    const p = findPortal(ctx, name);
    if (!p) return err(portalMiss(ctx, name));
    if (url && !isSupportedPortalUrl(url)) {
      return err(
        "yard: um portal abre páginas http/https (ou about:blank). " +
          `"${url}" não é um endereço que ele sirva.\n`,
      );
    }
    const href = url ? normalizePortalUrl(url) : p.url;
    commitCanvas(ctx.groupId, (c) =>
      patchItemOfType(c, p.id, "portal", {
        url: href,
        ...(live === undefined ? {} : { live }),
      }),
    );
    if (url) {
      try {
        await ipc.portalNavigate(p.id, href);
      } catch {
        await ensurePortalOpen({ ...p, url: href, groupId: ctx.groupId });
      }
    }
    const alive =
      live === undefined ? "" : ` (ao vivo: ${live ? "ligado" : "desligado"})`;
    return ok(
      `Portal "${ctx.portalNameOf.get(p.id)}" agora em ${href}${alive}\n`,
    );
  }

  const name = rest[0];
  if (!name && sub !== "ua" && sub) {
    return err(portalUsage());
  }

  const verbsNeedName = [
    "navigate",
    "info",
    "screenshot",
    "snapshot",
    "click",
    "fill",
    "type",
    "key",
    "hover",
    "focus",
    "select",
    "check",
    "uncheck",
    "scroll",
    "scrollintoview",
    "resize",
    "ua",
    "evaluate",
    "html",
    "text",
    "logs",
    "logs-start",
    "selectall",
    "clear",
  ];
  if (!verbsNeedName.includes(sub)) return err(portalUsage());

  const p = name ? findPortal(ctx, name) : null;
  if (!p) return err(portalMiss(ctx, name));

  const ready = async () => {
    try {
      await ipc.portalInfo(p.id);
    } catch {
      await ensurePortalOpen({ ...p, groupId: ctx.groupId });
    }
  };

  const run = async (js: string): Promise<BridgeResponse> => {
    await ready();
    try {
      const out = await evalPortal(p.id, js);
      if (out === "missing") {
        return err(
          `yard: seletor nao encontrado. Rode \`yard portal snapshot "${ctx.portalNameOf.get(p.id)}"\` de novo.\n`,
        );
      }
      return ok(out.endsWith("\n") ? out : out + "\n");
    } catch (e) {
      return err(`yard: portal eval falhou: ${e}\n`);
    }
  };

  switch (sub) {
    case "navigate": {
      const url = rest[1];
      if (!url) return err('uso: yard portal navigate "Nome" URL\n');
      const href = normalizePortalUrl(url);
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { url: href }),
      );
      await ready();
      await ipc.portalNavigate(p.id, href);
      return ok(`ok ${href}\n`);
    }
    case "info": {
      await ready();
      const raw = await evalPortal(p.id, INFO_JS);
      return ok(raw.endsWith("\n") ? raw : raw + "\n");
    }
    case "snapshot":
      return run(SNAPSHOT_JS);
    case "click": {
      if (!rest[1]) return err('uso: yard portal click "Nome" @e3|#id|x,y\n');
      return run(clickJs(rest[1]));
    }
    case "fill": {
      if (!rest[1] || rest[2] == null)
        return err('uso: yard portal fill "Nome" @e2 "valor"\n');
      return run(fillJs(rest[1], rest.slice(2).join(" ")));
    }
    case "type": {
      if (rest[1] == null)
        return err('uso: yard portal type "Nome" [@e2] "texto"\n');
      const looksSel =
        rest[1].startsWith("@") ||
        rest[1].startsWith("#") ||
        /^\d+,\d+/.test(rest[1]);
      if (looksSel && rest[2] != null)
        return run(typeJs(rest[1], rest.slice(2).join(" ")));
      return run(typeJs(undefined, rest.slice(1).join(" ")));
    }
    case "key": {
      if (!rest[1])
        return err('uso: yard portal key "Nome" Enter|Tab|ctrl+a\n');
      return run(keyJs(rest[1]));
    }
    case "hover":
      if (!rest[1]) return err('uso: yard portal hover "Nome" @e3\n');
      return run(hoverJs(rest[1]));
    case "focus":
      if (!rest[1]) return err('uso: yard portal focus "Nome" @e2\n');
      return run(focusJs(rest[1]));
    case "select":
      if (!rest[1] || rest[2] == null)
        return err('uso: yard portal select "Nome" @e5 "Opcao"\n');
      return run(selectJs(rest[1], rest.slice(2).join(" ")));
    case "check":
      if (!rest[1]) return err('uso: yard portal check "Nome" @e6\n');
      return run(checkJs(rest[1], true));
    case "uncheck":
      if (!rest[1]) return err('uso: yard portal uncheck "Nome" @e6\n');
      return run(checkJs(rest[1], false));
    case "scroll": {
      const dir = (rest[1] ?? "down").toLowerCase();
      const amount = Number(rest[2]) || 300;
      const at = rest[3];
      return run(scrollJs(dir, amount, at));
    }
    case "scrollintoview":
      if (!rest[1]) return err('uso: yard portal scrollintoview "Nome" @e10\n');
      return run(scrollIntoViewJs(rest[1]));
    case "resize": {
      const w = Number(rest[1]);
      const h = Number(rest[2]);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 160) {
        return err('uso: yard portal resize "Nome" 390 844\n');
      }
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { w, h, viewport: { w, h } }),
      );
      return ok(`viewport: ${w}x${h}\n`);
    }
    case "ua": {
      const preset = rest[1];
      if (!preset) {
        return ok(
          `ua atual: ${p.ua ?? "desktop"}\npresets: ${UA_PRESET_IDS.join(", ")}\n`,
        );
      }
      const resolved = resolveUa(preset);
      commitCanvas(ctx.groupId, (c) =>
        patchItemOfType(c, p.id, "portal", { ua: resolved }),
      );
      await ready();
      await ipc.portalSetUa(p.id, resolved ?? null);
      return ok(`ua: ${preset}\n`);
    }
    case "evaluate": {
      const js = rest.slice(1).join(" ");
      if (!js)
        return err('uso: yard portal evaluate "Nome" "document.title"\n');
      return run(js);
    }
    case "html":
      return run(HTML_JS);
    case "text":
      if (!rest[1]) return err('uso: yard portal text "Nome" @e1\n');
      return run(textJs(rest[1]));
    case "logs-start":
      return run(LOGS_START_JS);
    case "logs":
      return run(LOGS_JS);
    case "screenshot": {
      await ready();
      try {
        const path = await ipc.portalScreenshot(p.id);
        return ok(`${path}\n`);
      } catch (e) {
        return err(`yard: screenshot falhou: ${e}\n`);
      }
    }
    case "selectall":
      return run(
        rest[1]
          ? `(() => { const el = document.querySelector('[data-yard-ref=${JSON.stringify(rest[1])}]') || document.activeElement; if (el && el.select) el.select(); return "ok"; })()`
          : `(() => { const el = document.activeElement; if (el && el.select) el.select(); return "ok"; })()`,
      );
    case "clear":
      return run(
        rest[1]
          ? fillJs(rest[1], "")
          : `(() => { const el = document.activeElement; if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } return "ok"; })()`,
      );
    default:
      return err(portalUsage());
  }
}

function portalUsage(): string {
  return (
    "uso: yard portal create|edit|close|navigate|snapshot|click|fill|type|key|\n" +
    "             hover|focus|select|check|scroll|resize|ua|screenshot|evaluate|\n" +
    "             html|text|info|logs …  (veja `yard help`)\n"
  );
}
