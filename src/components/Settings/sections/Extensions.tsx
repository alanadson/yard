/**
 * Extensions — the panel of switches.
 *
 * The full store (`Ctrl+Shift+X`) is still the place to choose: it has live
 * previews, author, license and the color themes. This is the panel for
 * whoever already knows what to turn on — name, one line, the switch. The
 * color themes stay out because they take turns and are chosen by palette
 * (`extensoesDeAjustes`, with a test).
 *
 * The two icon themes also take turns, and still come in as switches: they
 * sit side by side, so the one that goes off is in sight — the store retires
 * it. What a click asks of the store is decided in one place, shared with the
 * store's card (`extensionInput`, with a test).
 *
 * The catalog (`lib/extensions.ts`) keeps its Portuguese; name, line and
 * chip are translated here, where they are drawn.
 */
import {
  extensionInput,
  EXTENSION_KINDS,
  settingsExtensions,
  type ExtensionDef,
} from "../../../lib/extensions";
import { useT } from "../../../hooks/useT";
import { useExtensions } from "../../../stores/extensionsStore";
import { useUI } from "../../../stores/uiStore";
import { logoOf } from "../../modals/extLogos";
import { Card } from "../rows";

function ExtensionRow({ ext }: { ext: ExtensionDef }) {
  const t = useT();
  const on = useExtensions((s) => s.enabled[ext.id] === true);
  const setEnabled = useExtensions((s) => s.setEnabled);
  const chip = EXTENSION_KINDS.find((k) => k.id === ext.kind)?.chip ?? ext.kind;

  return (
    <div className="set-ext">
      <span className="set-ext-logo" aria-hidden="true">
        {logoOf(ext)}
      </span>
      <span className="set-ext-text">
        <span className="set-row-label">{t(ext.name)}</span>
        <small className="set-row-desc set-ext-desc">{t(ext.description)}</small>
      </span>
      <span className="set-chip">{t(chip)}</span>
      <input {...extensionInput(ext, on, setEnabled)} aria-label={t(ext.name)} />
    </div>
  );
}

export function SecExtensions() {
  const t = useT();
  const openModal = useUI((s) => s.openModal);
  return (
    <>
      <Card>
        {settingsExtensions().map((ext) => (
          <ExtensionRow ext={ext} key={ext.id} />
        ))}
      </Card>
      <p className="hint">
        {t("Tudo já vem com o Yard — ligar é instalar, e vale na hora, sem reiniciar.")}{" "}
        <button className="linkish" onClick={() => openModal("extensions")}>
          {t("A loja completa")}
        </button>
        {t(", com prévias ao vivo e os temas de cor, abre com Ctrl+Shift+X.")}
      </p>
    </>
  );
}
