/**
 * What image paste promises: text always wins, only raster images get through,
 * a file with no MIME is still recognized by its name, and the path never
 * sticks to the neighboring word.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CLIPBOARD_IMAGE_MAX_BYTES,
  isPastedImage,
  pickPastedImage,
  saveClipboardImage,
  toBase64,
  withPathAtCaret,
  type PastedData,
} from "./clipboardImage";
import { ipc } from "./ipc";

/** A fake `DataTransferItem` — only what `pickPastedImage` looks at. */
function item(type: string, file: File | null, kind = "file") {
  return { kind, type, getAsFile: () => file };
}

function file(name: string, type: string): File {
  return { name, type, size: 1 } as File;
}

function data(parts: Partial<PastedData>): PastedData {
  return { getData: () => "", ...parts };
}

describe("isPastedImage", () => {
  it("accepts the raster formats a CLI can attach", () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp",
      "image/bmp",
    ]) {
      expect(isPastedImage({ type })).toBe(true);
    }
  });

  it("rejects SVG and non-images", () => {
    expect(isPastedImage({ type: "image/svg+xml" })).toBe(false);
    expect(isPastedImage({ type: "text/plain" })).toBe(false);
    expect(isPastedImage({ type: "application/pdf" })).toBe(false);
  });

  it("falls back to the name when the host sends no MIME", () => {
    expect(isPastedImage({ type: "", name: "captura.PNG" })).toBe(true);
    expect(isPastedImage({ type: "", name: "notas.txt" })).toBe(false);
    expect(isPastedImage({ type: "", name: "" })).toBe(false);
    // A folder whose *name* ends in .png is still not an image file.
    expect(isPastedImage({ type: "", name: "capturas.png/relatorio" })).toBe(false);
  });
});

describe("pickPastedImage", () => {
  it("finds the image among items of other kinds", () => {
    const png = file("captura.png", "image/png");
    const picked = pickPastedImage(
      data({
        items: [
          item("text/html", null, "string"),
          item("text/plain", null, "string"),
          item("image/png", png),
        ],
      }),
    );
    expect(picked).toBe(png);
  });

  it("falls back to `files` when only that list is filled", () => {
    const jpg = file("foto.jpg", "image/jpeg");
    expect(pickPastedImage(data({ items: [], files: [jpg] }))).toBe(jpg);
  });

  it("returns null when the paste carries no image", () => {
    expect(pickPastedImage(null)).toBeNull();
    expect(pickPastedImage(data({}))).toBeNull();
    expect(
      pickPastedImage(data({ items: [item("application/pdf", file("a.pdf", "application/pdf"))] })),
    ).toBeNull();
    // An item that says "image" but hands back nothing is not an image.
    expect(pickPastedImage(data({ items: [item("image/png", null)] }))).toBeNull();
  });
});

describe("toBase64", () => {
  it("matches btoa for small payloads", () => {
    expect(toBase64(new Uint8Array([77, 97, 110]))).toBe("TWFu");
    expect(toBase64(new Uint8Array([77]))).toBe("TQ==");
    expect(toBase64(new Uint8Array())).toBe("");
  });

  it("survives a payload far past the argument limit", () => {
    // 200k bytes: `String.fromCharCode(...bytes)` in one go throws here.
    const bytes = new Uint8Array(200_000).fill(0xab);
    const encoded = toBase64(bytes);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    expect(atob(encoded).length).toBe(bytes.length);
  });
});

describe("saveClipboardImage", () => {
  it("sends the bytes and returns the path the backend wrote", async () => {
    const spy = vi
      .spyOn(ipc, "clipboardSaveImage")
      .mockResolvedValue("C:\\Temp\\yard-clipboard\\yard-1.png");
    const path = await saveClipboardImage({
      type: "image/png",
      size: 3,
      arrayBuffer: async () => new Uint8Array([77, 97, 110]).buffer,
    });
    expect(spy).toHaveBeenCalledWith("TWFu");
    expect(path).toBe("C:\\Temp\\yard-clipboard\\yard-1.png");
    spy.mockRestore();
  });

  it("refuses an oversized image before reading it", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      saveClipboardImage({
        type: "image/png",
        size: CLIPBOARD_IMAGE_MAX_BYTES + 1,
        arrayBuffer: arrayBuffer as unknown as () => Promise<ArrayBuffer>,
      }),
    ).rejects.toThrow(/MB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("refuses an empty image", async () => {
    await expect(
      saveClipboardImage({
        type: "image/png",
        size: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/vazia/);
  });
});

describe("withPathAtCaret", () => {
  const P = "C:\\Temp\\a.png";

  it("keeps the path apart from the words around it", () => {
    expect(withPathAtCaret("veja isto:", 10, 10, P).text).toBe(`veja isto: ${P}`);
    expect(withPathAtCaret("antesdepois", 5, 5, P).text).toBe(`antes ${P} depois`);
  });

  it("adds no space where there already is one (or an edge)", () => {
    expect(withPathAtCaret("", 0, 0, P).text).toBe(P);
    expect(withPathAtCaret("veja ", 5, 5, P).text).toBe(`veja ${P}`);
    expect(withPathAtCaret("veja \nfim", 5, 5, P).text).toBe(`veja ${P}\nfim`);
  });

  it("replaces the selection and leaves the caret after the path", () => {
    const { text, caret } = withPathAtCaret("troque ISSO aqui", 7, 11, P);
    expect(text).toBe(`troque ${P} aqui`);
    expect(text.slice(0, caret)).toBe(`troque ${P}`);
  });
});
