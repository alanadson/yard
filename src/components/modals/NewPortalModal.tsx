/**
 * "Novo portal" — URL, optional name, user-agent picker, storage scope.
 * The page always runs inside Yard (WebView2). Chrome/Firefox/Edge in
 * the list only change the UA string — they never open a window on the PC.
 */
import { useMemo, useState } from "react";
import { nanoid } from "nanoid";

import { Modal } from "./Modal";
import { normalizePortalUrl, UA_CHOICES, type UaChoice } from "../../lib/portals";
import {
  PORTAL_DEFAULT_H,
  PORTAL_DEFAULT_W,
  type PortalStorage,
} from "../../lib/canvas";
import { useProjects } from "../../stores/projectsStore";
import { useUI } from "../../stores/uiStore";

export interface NewPortalPayload {
  groupId?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  url?: string;
  name?: string;
}

export function NewPortalModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as NewPortalPayload | null;
  const groups = useProjects((s) => s.groups);
  const activeGroupId = useProjects((s) => s.activeGroupId);
  const updateCanvas = useProjects((s) => s.updateCanvas);

  const [tab, setTab] = useState<"browser" | "devices">("browser");
  const [url, setUrl] = useState(payload?.url ?? "");
  const [name, setName] = useState(payload?.name ?? "");
  const [choiceId, setChoiceId] = useState("default");
  const [customUa, setCustomUa] = useState("");
  const [storage, setStorage] = useState<PortalStorage>("instance");

  const groupId = payload?.groupId ?? activeGroupId ?? groups[0]?.id ?? "";

  const choice = UA_CHOICES.find((c) => c.id === choiceId) ?? UA_CHOICES[0];
  const groupsOf = useMemo(() => {
    const out: { key: UaChoice["group"]; items: UaChoice[] }[] = [
      { key: "default", items: [] },
      { key: "engine", items: [] },
      { key: "device", items: [] },
    ];
    for (const c of UA_CHOICES) {
      out.find((g) => g.key === c.group)!.items.push(c);
    }
    return out;
  }, []);

  const create = () => {
    if (!groupId) {
      showToast("Abra um grupo em canvas antes de criar um portal.", "error");
      return;
    }
    const href = normalizePortalUrl(url);
    if (!href || href === "https://" || href === "http://") {
      showToast("Informe uma URL.", "error");
      return;
    }
    const ua =
      choice.kind === "custom"
        ? customUa.trim() || undefined
        : choice.ua;
    const id = nanoid(8);
    updateCanvas(groupId, (c) => ({
      ...c,
      items: [
        ...c.items,
        {
          id,
          type: "portal" as const,
          x: payload?.x ?? 80,
          y: payload?.y ?? 80,
          w: payload?.w ?? PORTAL_DEFAULT_W,
          h: payload?.h ?? PORTAL_DEFAULT_H,
          url: href,
          color: "#f5f5f5",
          engine: "webview2",
          storage,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(ua ? { ua } : {}),
        },
      ],
    }));
    closeModal();
  };

  return (
    <Modal
      title="Novo portal"
      onClose={closeModal}
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={tab !== "browser"}
            onClick={create}
          >
            Criar
          </button>
        </div>
      }
    >
      {tab === "devices" ? (
        <div className="form">
          <div className="tabs" role="tablist" style={{ order: -1 }}>
            <button
              role="tab"
              aria-selected={false}
              onClick={() => setTab("browser")}
            >
              Navegador
            </button>
            <button
              role="tab"
              aria-selected
              className="is-active"
              onClick={() => setTab("devices")}
            >
              Dispositivos
            </button>
          </div>
          <p className="hint">
            Emulador Android e celular via ADB entram depois. Por enquanto o
            portal é um navegador no canvas.
          </p>
        </div>
      ) : (
        <div className="form">
          <div className="tabs" role="tablist" style={{ order: -1 }}>
            <button
              role="tab"
              aria-selected
              className="is-active"
              onClick={() => setTab("browser")}
            >
              Navegador
            </button>
            <button
              role="tab"
              aria-selected={false}
              onClick={() => setTab("devices")}
            >
              Dispositivos
            </button>
          </div>
          <label>
            URL
            <input
              value={url}
              placeholder="https://localhost:5173"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </label>
          <label>
            Nome
            <input
              value={name}
              placeholder="Opcional"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Agente de usuário
            <select
              value={choiceId}
              onChange={(e) => setChoiceId(e.target.value)}
            >
              {groupsOf.map((g) => (
                <optgroup
                  key={g.key}
                  label={
                    g.key === "default"
                      ? "Padrão"
                      : g.key === "engine"
                        ? "Navegador"
                        : "Dispositivo"
                  }
                >
                  {g.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {choice.kind === "custom" && (
            <label>
              UA personalizado
              <input
                value={customUa}
                placeholder="Mozilla/5.0 …"
                onChange={(e) => setCustomUa(e.target.value)}
              />
            </label>
          )}
          <label>
            Armazenamento
            <select
              value={storage}
              onChange={(e) => setStorage(e.target.value as PortalStorage)}
            >
              <option value="instance">Isolado</option>
              <option value="workspace">Deste projeto</option>
              <option value="global">Global</option>
            </select>
          </label>
        </div>
      )}
    </Modal>
  );
}
