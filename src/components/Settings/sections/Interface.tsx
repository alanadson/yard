/**
 * Interface — appearance, language, the app's font and what the title bar
 * shows.
 *
 * The reference migration for `t()`: every sentence stays in Portuguese in
 * the source, `useT()` subscribes the section to the language, and the
 * English lines live in `src/i18n/en/settings.ts`.
 */
import { fontOptions } from "../../../lib/fontPicker";
import { isLangPref } from "../../../lib/i18n";
import { isThemePref } from "../../../lib/theme";
import { useT } from "../../../hooks/useT";
import { useUI } from "../../../stores/uiStore";
import { type SettingsCategory } from "../categories";
import { Card, GroupTitle, PickerRow, SwitchRow } from "../rows";
import { type Fonts } from "../useFonts";

export function SecInterface({
  fontes: fontList,
  goTo,
}: {
  fontes: Fonts;
  /** Goes to another category — the menu, called from inside the text. */
  goTo: (cat: SettingsCategory) => void;
}) {
  const t = useT();
  const uiFontFamily = useUI((s) => s.prefs.uiFontFamily);
  const theme = useUI((s) => s.prefs.theme);
  const lang = useUI((s) => s.prefs.lang);
  const setPref = useUI((s) => s.setPref);

  return (
    <>
      <GroupTitle>{t("Aparência")}</GroupTitle>
      <Card>
        <PickerRow
          label={t("Tema")}
          value={theme}
          options={[
            { value: "dark", label: t("Escuro") },
            { value: "light", label: t("Claro") },
            { value: "system", label: t("Sistema") },
          ]}
          onChange={(v) => setPref("theme", isThemePref(v) ? v : "dark")}
        />
      </Card>
      <p className="hint">
        {t(
          "Escuro é a cara do Yard; Claro troca o papel, não a linguagem — o azul, os raios e a semântica das cores ficam. Sistema segue o Windows. As extensões de tema de cor continuam mandando no terminal e no editor.",
        )}
      </p>

      <GroupTitle>{t("Idioma")}</GroupTitle>
      <Card>
        <PickerRow
          label={t("Idioma da interface")}
          value={lang}
          // Each language names itself: whoever cannot read the current one
          // still finds their own in the list.
          options={[
            { value: "pt-BR", label: "Português (Brasil)" }, // i18n-ok
            { value: "en", label: "English" },
            { value: "system", label: t("Sistema") },
          ]}
          onChange={(v) => setPref("lang", isLangPref(v) ? v : "pt-BR")}
        />
      </Card>
      <p className="hint">
        {t("Muda só a interface do Yard: os terminais e as CLIs falam a língua delas.")}
      </p>

      <GroupTitle>{t("Fontes")}</GroupTitle>
      <Card>
        <PickerRow
          label={t("Fonte da interface")}
          value={uiFontFamily}
          disabled={fontList.carregando}
          placeholder={fontList.carregando ? t("Procurando fontes…") : undefined}
          options={fontOptions(fontList.lista, false, uiFontFamily, t("Padrão do Yard"))}
          onChange={(v) => setPref("uiFontFamily", v)}
        />
      </Card>
      {/* A failed scan left the pickers with the handful of bundled fonts and
          no explanation — reading the machine seemed to say it has no fonts
          at all. */}
      {fontList.scan.state === "falhou" && (
        <p className="hint hint--error" role="alert">
          {t(
            "Não consegui ler as fontes instaladas nesta máquina: {reason}. Os seletores de fonte desta tela mostram só as que vêm com o Yard.",
            { reason: fontList.scan.reason },
          )}{" "}
          <button className="linkish" onClick={fontList.procurar}>
            {t("Procurar de novo")}
          </button>
        </p>
      )}
      <p className="hint">
        {t("A lista vem das fontes instaladas na máquina; as famílias que vêm com o Yard entram quando a")}{" "}
        <button className="linkish" onClick={() => goTo("extensoes")}>
          {t("extensão Fontes de código")}
        </button>{" "}
        {t("está ligada.")}
      </p>

      <GroupTitle>{t("Barra de título")}</GroupTitle>
      <Card>
        <SwitchRow
          pref="usageWidget"
          label={t("Medidor de limites de uso")}
          desc={t("Quanto resta das janelas do Claude, do Codex e do Grok, na barra de título")}
        />
      </Card>
    </>
  );
}
