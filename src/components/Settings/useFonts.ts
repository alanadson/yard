/**
 * The machine's font scan, shared by the three categories that have a font
 * picker (Interface, Terminal, Code editor).
 *
 * Failure does **not** become an empty list: the pickers stay usable (the
 * current font still counts), but the screen says the scan failed — instead
 * of letting the user conclude the machine has no fonts installed at all.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { BUNDLED_FONTS } from "../../lib/bundledFonts";
import { LOADING, load, type LoadState } from "../../lib/loading";
import { ipc, type FontFamilyInfo } from "../../lib/ipc";
import { useExtensions } from "../../stores/extensionsStore";

/**
 * The scan, shared across openings of the screen. The backend keeps the
 * result too; this promise only spares the IPC round trip and the flash of an
 * empty picker on reopening.
 */
let fontsPromise: Promise<FontFamilyInfo[]> | null = null;
const readFonts = () =>
  (fontsPromise ??= ipc.listFonts().catch((e) => {
    fontsPromise = null;
    throw e;
  }));

export interface Fonts {
  /** What the pickers offer, or `null` while the scan is running. */
  lista: FontFamilyInfo[] | null;
  /** The raw state — the screen uses `falhou` to explain the short list. */
  scan: LoadState<FontFamilyInfo[]>;
  carregando: boolean;
  procurar: () => void;
  /** The ligatures box only shows for a font whose GSUB really has the feature. */
  hasLigatures: (family: string) => boolean;
}

export function useFonts(): Fonts {
  const [scan, setScan] = useState<LoadState<FontFamilyInfo[]>>(LOADING);
  const installed = scan.state === "pronto" ? scan.data : null;
  const bundled = useExtensions((s) => s.enabled["code-fonts"] === true);

  /**
   * What the pickers offer: the scan plus, with the extension on, the families
   * that ship with Yard — first, because "ships with Yard" is the answer for
   * whoever opened the picker without a good mono installed.
   */
  const items = useMemo<FontFamilyInfo[] | null>(() => {
    if (!bundled || installed === null) return installed;
    const names = new Set(installed.map((f) => f.family));
    return [...BUNDLED_FONTS.filter((f) => !names.has(f.family)), ...installed];
  }, [installed, bundled]);

  const search = useCallback(() => {
    setScan(LOADING);
    void load(readFonts()).then(setScan);
  }, []);

  useEffect(search, [search]);

  return {
    lista: items,
    scan,
    carregando: scan.state === "carregando",
    procurar: search,
    hasLigatures: (family) =>
      items?.some((f) => f.family === family && f.ligatures) ?? false,
  };
}
