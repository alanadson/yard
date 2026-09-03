/**
 * JavaScript injected into a portal for snapshot / click / fill.
 * Kept as data (not executed here) so the same script runs in WebView2
 * and in a Chromium/Firefox page via CDP.
 */

export const SNAPSHOT_JS = `(() => {
  document.querySelectorAll("[data-yard-ref]").forEach((el) => el.removeAttribute("data-yard-ref"));
  const vw = window.innerWidth, vh = window.innerHeight;
  const lines = ["viewport: " + vw + "x" + vh + "  url: " + location.href + "  title: " + (document.title || "")];
  const sel = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 80) break;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    n += 1;
    const ref = "@e" + n;
    el.setAttribute("data-yard-ref", ref);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type");
    let name = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || (el).innerText || (el).value || "").toString();
    name = name.trim().replace(/\\s+/g, " ").slice(0, 60);
    const href = el instanceof HTMLAnchorElement ? el.href : "";
    const focused = document.activeElement === el ? " *focused*" : "";
    const extra = (type ? " type=" + type : "") + (href ? " href=" + href : "");
    lines.push(ref + " " + tag + extra + " " + JSON.stringify(name) + " [" + Math.round(r.left) + "," + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height) + "]" + focused);
  }
  return lines.join("\\n");
})()`;

export function resolveSelectorJs(sel: string): string {
  const s = sel.trim();
  if (s.startsWith("@")) {
    return `document.querySelector('[data-yard-ref=${JSON.stringify(s)}]')`;
  }
  const xy = s.match(/^(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)$/);
  if (xy) {
    return `document.elementFromPoint(${xy[1]}, ${xy[2]})`;
  }
  return `document.querySelector(${JSON.stringify(s)})`;
}

/**
 * The mark an agent's action leaves on the element it touched: a ring in
 * the board's accent that fades out and removes itself. Drawn inside the
 * page (the engine is an OS window nothing in the app can paint over), in
 * a fixed box so the page's own layout is never disturbed.
 */
export const MARK_JS = `const __yardMark = (el, kind) => {
      try {
        const r = el.getBoundingClientRect();
        const box = document.createElement("div");
        box.setAttribute("data-yard-mark", kind);
        box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;left:" + (r.left - 3) + "px;top:" + (r.top - 3) + "px;width:" + (r.width + 6) + "px;height:" + (r.height + 6) + "px;border:2px solid rgba(74,158,255,.95);border-radius:6px;box-shadow:0 0 0 4px rgba(74,158,255,.22);opacity:1;transition:opacity .35s ease .5s";
        const dot = document.createElement("div");
        dot.style.cssText = "position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;border-radius:50%;background:rgba(74,158,255,.95);box-shadow:0 1px 3px rgba(0,0,0,.45)";
        box.appendChild(dot);
        document.documentElement.appendChild(box);
        requestAnimationFrame(() => { box.style.opacity = "0"; });
        setTimeout(() => box.remove(), 950);
      } catch (e) {}
    };`;

export function clickJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    ${MARK_JS}
    el.scrollIntoView({ block: "center", inline: "nearest" });
    __yardMark(el, "click");
    if (el.focus) el.focus();
    el.click();
    return "ok";
  })()`;
}

export function fillJs(sel: string, value: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    ${MARK_JS}
    el.scrollIntoView({ block: "center", inline: "nearest" });
    __yardMark(el, "fill");
    if (el.focus) el.focus();
    const v = ${JSON.stringify(value)};
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(el, v);
    else if ("value" in el) el.value = v;
    else el.textContent = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;
}

export function typeJs(sel: string | undefined, text: string): string {
  const target = sel ? resolveSelectorJs(sel) : "document.activeElement";
  return `(() => {
    const el = ${target} || document.activeElement;
    if (!el) return "missing";
    ${MARK_JS}
    __yardMark(el, "type");
    if (el.focus) el.focus();
    const v = ${JSON.stringify(text)};
    if ("value" in el) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      const next = (el.value || "") + v;
      if (setter) setter.call(el, next); else el.value = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.textContent = (el.textContent || "") + v;
    }
    return "ok";
  })()`;
}

export function keyJs(key: string): string {
  const map: Record<string, string> = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    space: " ",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  const raw = key.trim();
  const parts = raw.toLowerCase().split("+");
  const main = parts.pop() || "";
  const keyName = map[main] || raw.split("+").pop() || raw;
  const ctrl = parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  return `(() => {
    const el = document.activeElement || document.body;
    const opts = { key: ${JSON.stringify(keyName)}, bubbles: true, cancelable: true, ctrlKey: ${ctrl}, metaKey: ${ctrl}, shiftKey: ${shift}, altKey: ${alt} };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    if (${JSON.stringify(keyName)} === "Enter" && el.form) el.form.requestSubmit();
    return "ok";
  })()`;
}

export function hoverJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    ${MARK_JS}
    __yardMark(el, "hover");
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return "ok";
  })()`;
}

export function focusJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    el.focus();
    return "ok";
  })()`;
}

export function selectJs(sel: string, option: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el || el.tagName !== "SELECT") return "missing";
    const want = ${JSON.stringify(option)}.toLowerCase();
    const opt = Array.from(el.options).find((o) => o.text.toLowerCase() === want || o.value.toLowerCase() === want);
    if (!opt) return "missing-option";
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;
}

export function checkJs(sel: string, on: boolean): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    if ("checked" in el) el.checked = ${on};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;
}

export function scrollJs(dir: string, amount: number, sel?: string): string {
  const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
  const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
  const target = sel ? resolveSelectorJs(sel) : "null";
  return `(() => {
    const el = ${target};
    const box = el || document.scrollingElement || document.documentElement;
    box.scrollBy(${dx}, ${dy});
    return "ok";
  })()`;
}

export function scrollIntoViewJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    el.scrollIntoView({ block: "center", inline: "nearest" });
    return "ok";
  })()`;
}

export const INFO_JS = `(() => ({
  url: location.href,
  title: document.title,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  ua: navigator.userAgent
}))()`;

export const HTML_JS = `document.documentElement ? document.documentElement.outerHTML.slice(0, 200000) : ""`;

export function textJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "";
    return (el.innerText || el.textContent || "").toString();
  })()`;
}

export const LOGS_JS = `(() => {
  const rows = (window.__yardLogs || []).slice();
  window.__yardLogs = [];
  return rows.join("\\n");
})()`;

export const LOGS_START_JS = `(() => { window.__yardLogs = window.__yardLogs || []; return "ok"; })()`;

// ---------------------------------------------------------------------------
// design mode — pointing at an element instead of describing it
// ---------------------------------------------------------------------------

/**
 * Arms the picker: a highlight follows the cursor and the next click captures
 * the element instead of reaching the page.
 *
 * The capture phase plus `preventDefault` is what keeps the click from being
 * a real click — pointing at a "Comprar" button must not buy anything. The
 * overlay is `pointer-events: none` so `elementFromPoint` never returns it.
 *
 * Everything is parked on `window.__yardGrab` because the app can only talk to
 * the page through one-shot `eval`s: the picker has to survive between them.
 */
export const GRAB_START_JS = `(() => {
  if (window.__yardGrab) return "ok";
  const st = { pick: null, stop: null };
  window.__yardGrab = st;

  const box = document.createElement("div");
  const tag = document.createElement("div");
  const hint = document.createElement("div");
  const common = "position:fixed;z-index:2147483647;pointer-events:none;";
  box.style.cssText = common + "border:2px solid #0a84ff;background:rgba(10,132,255,.14);border-radius:2px;display:none;";
  tag.style.cssText = common + "background:#0a84ff;color:#fff;font:11px/1.5 system-ui,sans-serif;padding:1px 6px;border-radius:4px;display:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  hint.style.cssText = common + "left:50%;bottom:16px;transform:translateX(-50%);background:rgba(20,20,24,.92);color:#f7f7f9;font:12px/1.5 system-ui,sans-serif;padding:6px 12px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);";
  hint.textContent = "Clique no elemento que precisa mudar  ·  Esc cancela"; // i18n-ok — script injected into the page, fixed at build
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tag);
  document.documentElement.appendChild(hint);

  const ours = (el) => el === box || el === tag || el === hint;
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\\w-]/g, "_"));

  const classesOf = (el) => {
    const raw = typeof el.className === "string" ? el.className : (el.getAttribute("class") || "");
    return clean(raw).split(" ").filter((c) => c && c.length < 40).slice(0, 4); // i18n-ok
  };

  const label = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = classesOf(el).slice(0, 2).map((c) => "." + c).join("");
    return el.tagName.toLowerCase() + id + cls;
  };

  // Shortest path that still identifies the node: an id ends it, otherwise
  // tag + a class + nth-of-type when siblings share the tag.
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift("#" + esc(node.id)); break; }
      let sel = node.tagName.toLowerCase();
      const cls = classesOf(node)[0];
      if (cls) sel += "." + esc(cls);
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) sel += ":nth-of-type(" + (Array.prototype.indexOf.call(same, node) + 1) + ")";
      }
      parts.unshift(sel);
      node = node.parentElement;
      if (node === document.body || node === document.documentElement) break;
    }
    return parts.join(" > ");
  };

  // No width/height: the bounding box already carries them, and a second
  // pair of numbers that disagrees with it (content box vs border box) only
  // makes the agent doubt both.
  const STYLE_KEYS = ["display","position","margin","padding","color",
    "backgroundColor","border","borderRadius","fontFamily","fontSize","fontWeight",
    "lineHeight","textAlign","zIndex","flexDirection","gap","opacity"];

  // A computed style dump is mostly the defaults. What is worth sending is
  // what somebody *decided* — the rest is noise the agent has to read past.
  const BORING = { position:"static", display:"inline", margin:"0px", padding:"0px",
    opacity:"1", fontWeight:"400", flexDirection:"row", textAlign:"start",
    color:"rgb(0, 0, 0)" };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLE_KEYS) {
      const v = cs[k];
      if (!v || v === "auto" || v === "normal" || v === "none") continue;
      if (v === "rgba(0, 0, 0, 0)" || BORING[k] === v) continue;
      if (k === "border" && v.indexOf("0px none") === 0) continue;
      styles[k] = v;
    }
    const attrs = {};
    for (const name of ["data-testid","data-test","name","type","href","src","alt","title","placeholder","role","aria-label"]) {
      const v = el.getAttribute && el.getAttribute(name);
      if (v) attrs[name] = clean(v).slice(0, 200);
    }
    let html = "";
    try { html = el.outerHTML.slice(0, 1600); } catch (e) { html = ""; }
    const parent = el.parentElement;
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      classes: classesOf(el),
      selector: cssPath(el),
      parent: parent ? label(parent) : "",
      text: clean(el.innerText || el.textContent || "").slice(0, 300),
      attrs: attrs,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      styles: styles,
      html: html
    };
  };

  let current = null;
  const paint = (el) => {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
    tag.style.display = "block";
    tag.textContent = label(el) + "  " + Math.round(r.width) + "x" + Math.round(r.height);
    tag.style.left = Math.max(2, r.left) + "px";
    tag.style.top = (r.top > 22 ? r.top - 21 : r.bottom + 4) + "px";
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el)) return;
    current = el;
    paint(el);
  };
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  const onClick = (e) => {
    swallow(e);
    const el = current || document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el)) return;
    st.pick = describe(el);
    stop();
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    swallow(e);
    st.pick = { cancelled: true };
    stop();
  };
  function stop() {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousedown", swallow, true);
    removeEventListener("mouseup", swallow, true);
    removeEventListener("keydown", onKey, true);
    box.remove(); tag.remove(); hint.remove();
    st.stop = null;
  }
  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("mousedown", swallow, true);
  addEventListener("mouseup", swallow, true);
  addEventListener("keydown", onKey, true);
  st.stop = stop;
  return "ok";
})()`;

/** Empty string = still picking. Anything else is the one and only answer. */
export const GRAB_POLL_JS = `(() => {
  const st = window.__yardGrab;
  if (!st || !st.pick) return "";
  const out = JSON.stringify(st.pick);
  delete window.__yardGrab;
  return out;
})()`;

export const GRAB_STOP_JS = `(() => {
  const st = window.__yardGrab;
  if (st && st.stop) st.stop();
  delete window.__yardGrab;
  return "ok";
})()`;
