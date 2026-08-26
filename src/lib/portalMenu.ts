import type { MenuEntry } from "../components/ContextMenu";
import type { PortalStorage } from "./canvas";
import { ipc } from "./ipc";
import { resolveUa, UA_PRESET_IDS } from "./portals";
import { t } from "./i18n";

interface PortalPreferenceMenuOptions {
  id: string;
  ua?: string;
  storage?: PortalStorage;
  instanceLabel: string;
  subject: string;
  patch: (change: { ua?: string; storage?: PortalStorage }) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
}

/** UA and cookie-profile entries shared by pane browsers and canvas portals. */
export function portalPreferenceMenu({
  id,
  ua,
  storage,
  instanceLabel,
  subject,
  patch,
  showToast,
}: PortalPreferenceMenuOptions): MenuEntry[] {
  const currentUa = UA_PRESET_IDS.find(
    (preset) => preset !== "desktop" && resolveUa(preset) === ua,
  );
  const userAgents: MenuEntry[] = UA_PRESET_IDS.map((preset) => ({
    id: `ua-${preset}`,
    label: preset === "desktop" ? t("UA: desktop (padrão)") : `UA: ${preset}`,
    checked: preset === "desktop" ? !ua : preset === currentUa,
    onSelect: () => {
      const next = preset === "desktop" ? undefined : resolveUa(preset);
      patch({ ua: next });
      void ipc.portalSetUa(id, next ?? null).catch((error) => showToast(String(error), "error"));
    },
  }));
  const scopes: PortalStorage[] = ["instance", "workspace", "global"];
  const labels: Record<PortalStorage, string> = {
    instance: t("Cookies: {whose}", { whose: instanceLabel }),
    workspace: t("Cookies: deste projeto"),
    global: t("Cookies: global"),
  };
  const currentStorage = storage ?? "instance";
  return [
    ...userAgents,
    { kind: "sep" },
    ...scopes.map((scope): MenuEntry => ({
      id: `st-${scope}`,
      label: labels[scope],
      checked: scope === currentStorage,
      onSelect: () => {
        if (scope === currentStorage) return;
        patch({ storage: scope });
        const whose =
          scope === "instance" ? instanceLabel : scope === "workspace" ? t("deste projeto") : t("globais");
        showToast(
          t("{subject} recarregado com os cookies {whose} — a sessão anterior fica no perfil antigo.", {
            subject,
            whose,
          }),
        );
      },
    })),
  ];
}
