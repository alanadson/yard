/**
 * Clipboard with a fallback.
 *
 * WebView2 can refuse `navigator.clipboard` depending on how the window was
 * focused, and a "Copiar" button that silently does nothing is worse than no
 * button. The hidden-textarea path is deprecated everywhere and still the only
 * thing that works when the permission is denied.
 */
/**
 * Reads the clipboard as text; `null` when the host refuses.
 *
 * Reading is stricter than writing: the main window is built from
 * `tauri.conf.json`, which has no equivalent to the `enable_clipboard_access()`
 * the portals get, so WebView2 treats `readText` as a permission request that
 * can be prompted or denied. The caller has to have something to say when it
 * comes back empty-handed — `null` is "the host said no", `""` is "the
 * clipboard has no text".
 */
export async function readClipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
