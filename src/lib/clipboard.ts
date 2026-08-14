/**
 * Clipboard with a fallback.
 *
 * WebView2 can refuse `navigator.clipboard` depending on how the window was
 * focused, and a "Copiar" button that silently does nothing is worse than no
 * button. The hidden-textarea path is deprecated everywhere and still the only
 * thing that works when the permission is denied.
 */
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
