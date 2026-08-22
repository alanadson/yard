/**
 * "Novo portal" — URL, optional name, user-agent picker, storage scope.
 * The page always runs inside Yard (WebView2). Chrome/Firefox/Edge in
 * the list only change the UA string — they never open a window on the PC.
 */
import { useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";

import { Modal } from "./Modal";
import { Select } from "../Select";
import {
  isSupportedPortalUrl,
  normalizePortalUrl,
  UA_CHOICES,
  type UaChoice,
} from "../../lib/portals";
import {
  PORTAL_DEFAULT_H,
  PORTAL_DEFAULT_W,
  type PortalStorage,
} from "../../lib/canvas";
import { placedCorners } from "../../lib/canvasOps";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { dropPointFor, unstack } from "../../lib/dropPoint";
import { goToCanvasItem } from "../../lib/navigate";
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

const STORAGE_OPTIONS = [
  { value: "instance", label: "Isolado" },
  { value: "workspace", label: "Deste projeto" },
  { value: "global", label: "Global" },
];

export function NewPortalModal() {
  const closeModal = useUI((s) => s.closeModal);
  const showToast = useUI((s) => s.showToast);
  const payload = useUI((s) => s.modalPayload) as NewPortalPayload | null;
  const groups = useProjects((s) => s.groups);
  const activeGroupId = useProjects((s) => s.activeGroupId);

  const [url, setUrl] = useState(payload?.url ?? "");
  const [name, setName] = useState(payload?.name ?? "");
  const [choiceId, setChoiceId] = useState("default");
  const [customUa, setCustomUa] = useState("");
  const [storage, setStorage] = useState<PortalStorage>("instance");
  /**
   * Error under the field, not in the footer: whoever is typing an address
   * looks at the address. The other two creation dialogs already did this.
   */
  const [err, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  const groupId = payload?.groupId ?? activeGroupId ?? groups[0]?.id ?? "";

  const choice = UA_CHOICES.find((c) => c.id === choiceId) ?? UA_CHOICES[0];
  // The list groups by origin, and the options come out already in that
  // order — the pop-up button draws a heading whenever the group changes.
  const uaOptions = useMemo(() => {
    const order: UaChoice["group"][] = ["default", "engine", "device"];
    const theTitle: Record<UaChoice["group"], string> = {
      default: "Padrão",
      engine: "Aparência (user-agent — o motor é sempre o WebView2)",
      device: "Dispositivo",
    };
    return order.flatMap((g) =>
      UA_CHOICES.filter((c) => c.group === g).map((c) => ({
        value: c.id,
        label: c.label,
        group: theTitle[g],
      })),
    );
  }, []);

  const create = () => {
    if (!groupId) {
      showToast("Abra um grupo em canvas antes de criar um portal.", "error");
      return;
    }
    // Asked before the card exists: the backend refuses anything that is not
    // the web, and a refused engine would otherwise leave a dead card sitting
    // on the canvas for the user to clean up.
    if (url.trim() && !isSupportedPortalUrl(url)) {
      setError(
        "Um portal abre páginas http/https. Endereços como file: não são suportados.",
      );
      urlRef.current?.focus();
      return;
    }
    const href = normalizePortalUrl(url);
    if (!href || href === "https://" || href === "http://") {
      setError("Informe o endereço da página.");
      urlRef.current?.focus();
      return;
    }
    const ua =
      choice.kind === "custom"
        ? customUa.trim() || undefined
        : choice.ua;
    const id = nanoid(8);
    const w = payload?.w ?? PORTAL_DEFAULT_W;
    const h = payload?.h ?? PORTAL_DEFAULT_H;
    // Opened with a point (the canvas menu, the W tool) the portal goes
    // exactly there; opened from the palette or a button it goes where the
    // mouse is. The old fallback was the fixed corner (80, 80), which on a
    // board with anything in it meant "on top of whatever is at the corner".
    const at =
      payload?.x !== undefined && payload.y !== undefined
        ? { x: payload.x, y: payload.y }
        : (dropPointFor(groupId, { w, h }) ?? { x: 80, y: 80 });
    // `commitCanvasExternal`, not `updateCanvas`: the canvas's undo keeps
    // whole-canvas snapshots, and this write does not push one. Left as a
    // plain update, a `Ctrl+Z` after creating a portal restored a snapshot
    // from *before* the card existed — the card vanished with no gesture
    // asking for it, and its WebView2 stayed running with nothing on screen
    // to reach it. Clearing the history is the same trade the CLI makes.
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      items: [
        ...c.items,
        {
          id,
          type: "portal" as const,
          ...unstack(at, placedCorners(c)),
          w,
          h,
          url: href,
          color: "#f5f5f5",
          engine: "webview2",
          storage,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(ua ? { ua } : {}),
        },
      ],
    }));
    // The card is born on the group's canvas — and the group may be in grid
    // mode, where there is no canvas on screen. Without this the dialog closed
    // and nothing happened: the portal stood (with a live WebView2) on a
    // screen the user did not know existed. Taking the screen to it is what
    // Search already does when revealing a note.
    goToCanvasItem(groupId, id);
    closeModal();
  };

  return (
    <Modal
      title="Novo portal"
      onClose={closeModal}
      dirty={!!url.trim() || !!name.trim() || !!customUa.trim()}
      initialFocus="#novo-portal-url"
      footer={
        <div className="modal-foot-row modal-foot-row--end">
          <button className="btn" onClick={closeModal}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={create}>
            Criar
          </button>
        </div>
      }
    >
      {/* The "Dispositivos" tab was an empty place that said "coming later" —
          the product advertising from within what does not exist. Promises
          are the roadmap's business; only what opens goes in here. */}
      <div className="form">
        <label>
          URL
          <input
            id="novo-portal-url"
            ref={urlRef}
            value={url}
            placeholder="https://localhost:5173"
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? "novo-portal-erro" : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </label>
        {err && (
          <p className="hint hint--error" id="novo-portal-erro" role="alert">
            {err}
          </p>
        )}
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
          <Select value={choiceId} options={uaOptions} onChange={setChoiceId} />
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
          <Select
            value={storage}
            options={STORAGE_OPTIONS}
            onChange={(v) => setStorage(v as PortalStorage)}
          />
        </label>
      </div>
    </Modal>
  );
}
