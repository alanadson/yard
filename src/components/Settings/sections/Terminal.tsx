/**
 * Terminal — font, rendering and scrollback of the CLI panes.
 */
import { familyFromStack, stackFrom, TERM_FALLBACK } from "../../../lib/fonts";
import { fontOptions } from "../../../lib/fontPicker";
import { useT } from "../../../hooks/useT";
import { useUI } from "../../../stores/uiStore";
import { Card, GroupTitle, NumberRow, PickerRow, SwitchRow } from "../rows";
import { type Fonts } from "../useFonts";

export function SecTerminal({ fontes: fontList }: { fontes: Fonts }) {
  const t = useT();
  const fontFamily = useUI((s) => s.prefs.fontFamily);
  const renderer = useUI((s) => s.prefs.renderer);
  const setPref = useUI((s) => s.setPref);
  const family = familyFromStack(fontFamily);
  const renderers = [
    { value: "canvas", label: t("Canvas (estável)") },
    { value: "webgl", label: t("WebGL (experimental)") },
  ];

  return (
    <>
      <Card>
        <PickerRow
          label={t("Fonte do terminal")}
          value={family}
          disabled={fontList.carregando}
          placeholder={fontList.carregando ? t("Procurando fontes…") : undefined}
          options={fontOptions(fontList.lista, true, family)}
          onChange={(v) => setPref("fontFamily", stackFrom(v, TERM_FALLBACK))}
        />
        <NumberRow pref="fontSize" label={t("Tamanho da fonte")} min={8} max={28} />
        <PickerRow
          label={t("Renderizador")}
          value={renderer}
          options={renderers}
          onChange={(v) => setPref("renderer", v as "canvas" | "webgl")}
        />
        <NumberRow
          pref="scrollback"
          label={t("Linhas de histórico")}
          min={1000}
          max={200000}
          step={1000}
          wide
        />
      </Card>

      <GroupTitle>{t("Aparência do terminal")}</GroupTitle>
      <Card>
        <SwitchRow
          pref="cursorBlink"
          label={t("Cursor piscante")}
          desc={t("O cursor do terminal pisca quando o painel está em foco")}
        />
        {/* Only for a font whose GSUB really has the feature: an option that
            exists with no effect teaches that the screen lies. */}
        {fontList.hasLigatures(family) && (
          <SwitchRow
            pref="termLigatures"
            label={t("Ligaduras no terminal")}
            desc={t("Desenha => e != como um símbolo só; o que os programas recebem não muda")}
          />
        )}
      </Card>
      <p className="hint">
        {t(
          "O renderizador WebGL é mais rápido em telas grandes, mas depende do driver de vídeo; se o terminal piscar ou ficar em branco, volte para canvas.",
        )}
      </p>
    </>
  );
}
