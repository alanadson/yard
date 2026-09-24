import { useState } from "react";
import { Modal } from "../modals/Modal";
import { Select } from "../Select";
import { useT } from "../../hooks/useT";
import { connectionIssue } from "./connectionForm";

export function ConnectionsDialog({
  endpoints,
  wires,
  initialSource,
  onCreate,
  onRemove,
  onStyle,
  onClose,
}: {
  endpoints: { value: string; label: string }[];
  wires: { id: string; from: string; to: string; style?: "rope" | "circuit" }[];
  initialSource?: string;
  onCreate: (from: string, to: string) => void;
  onRemove: (id: string) => void;
  onStyle: (id: string, style: "rope" | "circuit") => void;
  onClose: () => void;
}) {
  const t = useT();
  const [from, setFrom] = useState(initialSource ?? endpoints[0]?.value ?? "");
  const [to, setTo] = useState("");
  const [notice, setNotice] = useState("");
  const issue = connectionIssue(
    endpoints.map((endpoint) => endpoint.value),
    wires,
    from,
    to,
  );
  const name = (id: string) =>
    endpoints.find((endpoint) => endpoint.value === id)?.label ??
    t("Cartão removido ({id})", { id });
  return (
    <Modal title={t("Gerenciar conexões")} onClose={onClose} wide>
      <p className="hint">
        {t(
          "Uma conexão autoriza a comunicação entre agentes e o acesso ao contexto de cartões. A origem e o destino também definem a direção dos fluxos.",
        )}
      </p>
      {endpoints.length < 2 ? (
        <p className="hint">
          {t("Adicione pelo menos dois cartões para criar uma conexão.")}
        </p>
      ) : (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (issue) return;
            onCreate(from, to);
            setNotice(t("Conexão criada."));
            setTo("");
          }}
        >
          <label>
            {t("Origem")}
            <Select value={from} options={endpoints} onChange={setFrom} />
          </label>
          <label>
            {t("Destino")}
            <Select
              value={to}
              options={endpoints.filter((endpoint) => endpoint.value !== from)}
              placeholder={t("Escolha um cartão")}
              onChange={setTo}
            />
          </label>
          {issue === "duplicate" && (
            <p className="hint" role="status">
              {t("Esses dois já estão conectados.")}
            </p>
          )}
          <button className="btn btn--primary" disabled={!!issue} type="submit">
            {t("Criar conexão")}
          </button>
        </form>
      )}
      <p className="hint" role="status" aria-live="polite">
        {notice}
      </p>
      <h4>{t("Conexões existentes")}</h4>
      {wires.length === 0 && (
        <p className="hint">{t("Nenhuma conexão neste quadro.")}</p>
      )}
      <ul className="connection-list">
        {wires.map((wire) => (
          <li key={wire.id}>
            <span>
              {name(wire.from)} → {name(wire.to)}
            </span>
            <Select label={t("Estilo de conexão")} value={wire.style ?? "rope"}
              options={[{ value: "rope", label: t("Corda") }, { value: "circuit", label: t("Circuito") }]}
              onChange={(value) => onStyle(wire.id, value as "rope" | "circuit")} />
            <button
              className="btn btn--sm"
              aria-label={t("Remover conexão de {from} para {to}", {
                from: name(wire.from),
                to: name(wire.to),
              })}
              onClick={() => {
                onRemove(wire.id);
                setNotice(
                  t("Conexão removida. Use Desfazer no canvas para restaurar."),
                );
              }}
            >
              {t("Remover")}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
