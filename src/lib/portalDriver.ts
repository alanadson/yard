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

export function clickJs(sel: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    el.scrollIntoView({ block: "center", inline: "nearest" });
    if (el.focus) el.focus();
    el.click();
    return "ok";
  })()`;
}

export function fillJs(sel: string, value: string): string {
  return `(() => {
    const el = ${resolveSelectorJs(sel)};
    if (!el) return "missing";
    el.scrollIntoView({ block: "center", inline: "nearest" });
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
