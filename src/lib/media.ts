/**
 * Files you **look at** instead of editing: image, video, audio, PDF.
 *
 * The backend reports the type (`TextFile.media`, the extension table in
 * `explorer.rs`) and here it becomes two things: the family that picks the
 * element on screen (`<img>`, `<video>`, `<audio>`, `<iframe>`) and the address
 * the bytes come from.
 *
 * That address belongs to the `yardfile` protocol (`src-tauri/src/media.rs`).
 * It deliberately does not go over the IPC: a video delivered as base64 over
 * the IPC would be the whole file in memory before the first frame, and with no
 * `Range` the progress bar would not move. As a URL, the webview asks for the
 * chunks it needs.
 */
import { locale } from "./i18n";

export type MediaKind = "image" | "video" | "audio" | "pdf";

/**
 * A MIME type's family — `null` for anything that is not drawn on screen.
 *
 * `.svg` is the case that justifies looking at the MIME and not the extension:
 * it is image *and* text, arrives with `binary: false`, and the editor shows
 * both sides.
 */
export function mediaKind(mime: string | null | undefined): MediaKind | null {
  if (!mime) return null;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return null;
}

/**
 * The protocol's origin, in the form the platform uses.
 *
 * On Windows (and Android) WebView2 presents a registered scheme as
 * `http://<name>.localhost`; on other platforms it is `<name>://localhost`.
 * It is the same conversion `convertFileSrc` from `@tauri-apps/api` does — done
 * here because our URL carries root and path as a query, not a single path in
 * place of the path segment.
 */
function origin(): string {
  const windowsOrAndroid =
    typeof navigator !== "undefined" && /Windows|Android/i.test(navigator.userAgent);
  return windowsOrAndroid ? "http://yardfile.localhost" : "yardfile://localhost";
}

/**
 * The address of a project file's bytes.
 *
 * `version` (the file's mtime) is there only to change the URL when disk
 * changes: without it, an agent rewriting the screenshot would leave the screen
 * showing the old frame until someone closed the tab.
 */
export function mediaUrl(root: string, path: string, version = 0): string {
  // Escaped by hand, and not with `URLSearchParams`: that one writes a space as
  // `+` (the rule for an HTML form, not for a URL), and the other side reads
  // percent escapes only — deliberately, since a `+` in a file name is a `+`.
  // The result was that every photo or video whose name (or whose project
  // folder) had a space came back 404 and fell into the "open in the default
  // app" card: `foto de perfil.png`, `Área de Trabalho`, `C:\Users\Ana Maria`.
  const q = [`root=${encodeURIComponent(root)}`, `path=${encodeURIComponent(path)}`];
  if (version) q.push(`v=${version}`);
  return `${origin()}/?${q.join("&")}`;
}

/** File size the way a human reads it: `18,4 MB`, `912 KB`, `340 B`. */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  // One decimal place from MB upward, where it says something ("18,4 MB"), and
  // none in KB, where it would be noise ("912,3 KB").
  const decimals = i === 0 ? 0 : 1;
  // The decimal mark follows the interface language: "18,4 MB" in
  // Portuguese, "18.4 MB" in English.
  const number = value.toFixed(decimals);
  return `${locale() === "pt-BR" ? number.replace(".", ",") : number} ${units[i]}`;
}
