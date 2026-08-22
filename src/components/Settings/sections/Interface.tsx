/**
 * Interface — the app's font and what the title bar shows.
 */
import { fontOptions } from "../../../lib/fontPicker";
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
  const uiFontFamily = useUI((s) => s.prefs.uiFontFamily);
  const setPref = useUI((s) => s.setPref);

  return (
    <>
      <Card>
        <PickerRow
          label="Fonte da interface"
          value={uiFontFamily}
          disabled={fontList.carregando}
          placeholder={fontList.carregando ? "Procurando fontes…" : undefined}
          options={fontOptions(fontList.lista, false, uiFontFamily, "Padrão do Yard")}
          onChange={(v) => setPref("uiFontFamily", v)}
        />
      </Card>
      {/* A failed scan left the pickers with the handful of bundled fonts and
          no explanation — reading the machine seemed to say it has no fonts
          at all. */}
      {fontList.scan.state === "falhou" && (
        <p className="hint hint--error" role="alert">
          Não consegui ler as fontes instaladas nesta máquina:{" "}
          {fontList.scan.reason}. Os seletores de fonte desta tela mostram só as
          que vêm com o Yard.{" "}
          <button className="linkish" onClick={fontList.procurar}>
            Procurar de novo
          </button>
        </p>
      )}
      <p className="hint">
        A lista vem das fontes instaladas na máquina; as famílias que vêm com o
        Yard entram quando a{" "}
        <button className="linkish" onClick={() => goTo("extensoes")}>
          extensão Fontes de código
        </button>{" "}
        está ligada.
      </p>

      <GroupTitle>Barra de título</GroupTitle>
      <Card>
        <SwitchRow
          pref="usageWidget"
          label="Medidor de limites de uso"
          desc="Quanto resta das janelas do Claude, do Codex e do Grok, na barra de título"
        />
      </Card>
    </>
  );
}
