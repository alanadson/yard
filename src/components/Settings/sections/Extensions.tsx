/**
 * Extensions — the panel of switches.
 *
 * The full store (`Ctrl+Shift+X`) is still the place to choose: it has live
 * previews, author, license and the color themes. This is the panel for
 * whoever already knows what to turn on — name, one line, the switch. The
 * color themes stay out because they take turns and are chosen by palette
 * (`extensoesDeAjustes`, with a test).
 *
 * The two icon themes, which also take turns, come in as a radio: a switch
 * would promise independence and lie — the same rule as the store, now
 * written in a single place (`controleDeExtensao`).
 */
import {
  extensionControl,
  EXTENSION_KINDS,
  settingsExtensions,
  type ExtensionDef,
} from "../../../lib/extensions";
import { useExtensions } from "../../../stores/extensionsStore";
import { useUI } from "../../../stores/uiStore";
import { logoOf } from "../../modals/extLogos";
import { Card } from "../rows";

function ExtensionRow({ ext }: { ext: ExtensionDef }) {
  const on = useExtensions((s) => s.enabled[ext.id] === true);
  const setEnabled = useExtensions((s) => s.setEnabled);
  const radio = extensionControl(ext) === "radio";
  const chip = EXTENSION_KINDS.find((k) => k.id === ext.kind)?.chip ?? ext.kind;

  return (
    <div className="set-ext">
      <span className="set-ext-logo" aria-hidden="true">
        {logoOf(ext)}
      </span>
      <span className="set-ext-text">
        <span className="set-row-label">{ext.name}</span>
        <small className="set-row-desc set-ext-desc">{ext.description}</small>
      </span>
      <span className="set-chip">{chip}</span>
      <input
        type={radio ? "radio" : "checkbox"}
        role={radio ? undefined : "switch"}
        name={ext.category}
        className={radio ? "ext-radio" : "switch"}
        checked={on}
        onChange={() => setEnabled(ext.id, true)}
        onClick={() => {
          // Clicking the radio that is already on turns it off: no icon theme
          // at all is a valid choice too.
          if (radio && on) setEnabled(ext.id, false);
        }}
        aria-label={ext.name}
      />
    </div>
  );
}

export function SecExtensions() {
  const openModal = useUI((s) => s.openModal);
  return (
    <>
      <Card>
        {settingsExtensions().map((ext) => (
          <ExtensionRow ext={ext} key={ext.id} />
        ))}
      </Card>
      <p className="hint">
        Tudo já vem com o Yard — ligar é instalar, e vale na hora, sem
        reiniciar.{" "}
        <button className="linkish" onClick={() => openModal("extensions")}>
          A loja completa
        </button>
        , com prévias ao vivo e os temas de cor, abre com Ctrl+Shift+X.
      </p>
    </>
  );
}
