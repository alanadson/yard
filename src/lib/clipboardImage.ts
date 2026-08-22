/**
 * Pasting an image where only text fits.
 *
 * A PTY has no way to receive a PNG, which is why Ctrl+V of a screenshot
 * usually does nothing in a terminal. The agent CLIs solve this from outside:
 * when they recognize the **path of an image file** in what was pasted, they
 * open the file and attach the image themselves. So the job here is the detour
 * — clipboard bytes become a file in `%TEMP%` (`clipboard.rs`) and what goes
 * into the terminal is the path.
 *
 * WebView2 hands the image over for free in the `paste` event: a Win+Shift+S
 * capture, a browser's "copy image" and a Ctrl+C on a file in Explorer all
 * arrive as a `File` in `clipboardData`. Only the context menu ("Paste into
 * terminal") has no such event and has to ask the host for the image — hence
 * `readClipboardImage`, which can come back empty when WebView2 denies read
 * permission (see `clipboard.ts`).
 *
 * **Text beats image.** Copying from a page usually fills the clipboard with
 * both (`text/plain` + `image/png`); whoever copied a snippet of text wants the
 * text. The image only goes through when there is no text at all.
 *
 * Known caveat: the path goes in **raw**, unquoted, because that is how the
 * CLIs recognize it — the whole paste is the path and nothing else. The
 * directory comes from `%TEMP%`, which inherits the Windows user name; if that
 * name has a space, recognition depends on the CLI looking at the whole paste
 * instead of cutting at the first gap. The file name itself never has a space.
 */
import { ipc } from "./ipc";

/**
 * Cap on what we send over the IPC, matching the Rust side. A 4K screenshot in
 * PNG is ~10 MB; twice that is plenty of headroom and keeps the UI from
 * freezing while it builds a base64 string of hundreds of MB.
 */
export const CLIPBOARD_IMAGE_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Raster formats a CLI knows how to attach. SVG is deliberately out: it is
 * text, no agent treats it as an image, and the backend would refuse it anyway
 * (the extension there comes from the file's signature).
 */
const RASTER_MIME = /^image\/(png|jpe?g|gif|webp|bmp)$/i;
const RASTER_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** The minimum of a `File`/`Blob` this module needs — what makes it testable. */
export interface PastedImage {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Structural shape of `DataTransfer`, hand-written for the same reason. */
interface PastedItem {
  kind: string;
  type: string;
  getAsFile(): File | null;
}
export interface PastedData {
  items?: ArrayLike<PastedItem> | null;
  files?: ArrayLike<File> | null;
  getData?(format: string): string;
}

/**
 * Is it an image? `type` decides when present; a file coming from Explorer
 * sometimes arrives with no MIME and has only its name to identify itself.
 */
export function isPastedImage(file: { type?: string; name?: string }): boolean {
  if (file.type) return RASTER_MIME.test(file.type);
  return RASTER_EXT.test(file.name ?? "");
}

/**
 * The image the user pasted, or `null` when there was none.
 *
 * `items` comes first because it is the list that describes what the clipboard
 * holds; `files` is the safety net for when the host fills only that one
 * (which happens with files dragged from Explorer).
 */
export function pickPastedImage(data: PastedData | null | undefined): File | null {
  if (!data) return null;
  const items = data.items;
  for (let i = 0; i < (items?.length ?? 0); i += 1) {
    const item = items![i];
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isPastedImage(file)) return file;
  }
  const files = data.files;
  for (let i = 0; i < (files?.length ?? 0); i += 1) {
    const file = files![i];
    if (isPastedImage(file)) return file;
  }
  return null;
}

/**
 * Bytes → base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` over a whole image blows the engine's
 * argument stack — a screenshot is millions of bytes. 8 KB per pass is safe on
 * any engine and costs nothing.
 */
export function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Writes the image and returns the file's absolute path. Throws with a sentence
 * ready to become a toast — the caller has nothing to decide beyond showing it.
 */
export async function saveClipboardImage(image: PastedImage): Promise<string> {
  if (image.size > CLIPBOARD_IMAGE_MAX_BYTES) {
    const mb = Math.round(CLIPBOARD_IMAGE_MAX_BYTES / (1024 * 1024));
    throw new Error(`imagem maior que ${mb} MB`);
  }
  const bytes = new Uint8Array(await image.arrayBuffer());
  if (!bytes.length) throw new Error("imagem vazia");
  return ipc.clipboardSaveImage(toBase64(bytes));
}

/**
 * Asks the host for the image — the context-menu path, which has no `paste`
 * event to lean on. `null` when there is no image **or** when WebView2 denies
 * reading the clipboard (the same permission `readClipboardText` lacks in the
 * main window); both cases lead to the same outcome, which is asking the user
 * for Ctrl+V.
 */
export async function readClipboardImage(): Promise<Blob | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => RASTER_MIME.test(t));
      if (type) return await item.getType(type);
    }
  } catch {
    /* no permission, or no `read()` on this host */
  }
  return null;
}

/**
 * Fits a path into a field's text, at the caret (or over the selection), with a
 * space on either side when one is missing.
 *
 * The space is not aesthetics: dropped into the middle of a sentence,
 * `veja isto:C:\a.png` is not a path to anyone — not to the agent looking for a
 * file, nor to the user rereading their own prompt.
 */
export function withPathAtCaret(
  text: string,
  start: number,
  end: number,
  path: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const left = before && !/\s$/.test(before) ? " " : "";
  const right = after && !/^\s/.test(after) ? " " : "";
  const chunk = `${left}${path}${right}`;
  return { text: `${before}${chunk}${after}`, caret: before.length + chunk.length };
}
