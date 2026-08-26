/**
 * Agents — what each CLI is, and the two balloons its silence triggers.
 *
 * The balloons used to be a single switch. Turning off the "finished" one —
 * the first thing you do with six CLIs open — also killed the warning that
 * costs dead time to ignore. `lib/notifyAgent.ts` is what tells the two apart.
 *
 * The rest of the screen is the newer half, and it exists because "sem pedir
 * permissão" was a checkbox inside "Nova aba": the one setting everybody wants
 * permanently on had to be ticked again on every single tab, and no CLI born
 * anywhere else — the canvas' `yard recruit`, a fan-out of floors, a resumed
 * session — could be told at all.
 *
 * It first shipped as one block per agent, stacked. With nine CLIs detected
 * that is a nine-screen scroll of near-identical controls where the answer to
 * "how is Claude set up?" is three scrolls from the answer to "and Codex?".
 * So the agents became **tabs**: the marks in a strip, one panel underneath.
 * The rules are in `lib/agentDefaults.ts`; this screen is the tabs and the
 * panel. The catalog's own sentences (cache choices and notes, the skip-flag
 * hints, the role launch hint) keep their Portuguese there and are translated
 * here, where they are drawn.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Bot } from "lucide-react";

import { Card, GroupTitle, Row, SwitchRow } from "../rows";
import { BrandIcon } from "../../BrandIcon";
import { Select } from "../../Select";
import { RoleField } from "../../modals/RoleField";
import { useT } from "../../../hooks/useT";
import {
  agentDefaultRows,
  cacheChoicesOf,
  cacheNoteOf,
  isDefaultConfig,
  pickAgentTab,
  type AgentDefaultRow,
} from "../../../lib/agentDefaults";
import { brandById } from "../../../lib/brands";
import { ipc, type SshStatus, type WslStatus } from "../../../lib/ipc";
import { launchHint } from "../../../lib/roles";
import { hasFlag, withFlag } from "../../../lib/termArgs";
import { useAgentDefaults } from "../../../stores/agentDefaultsStore";
import { useAgents } from "../../../stores/agentsStore";

/** Sentinel of the distro picker: the one WSL itself defaults to. */
const DEFAULT_DISTRO = "__padrao__";

function AgentMark({ row }: { row: AgentDefaultRow }) {
  const brand = brandById(row.id);
  return brand ? <BrandIcon brand={brand} size={20} /> : <Bot size={17} />;
}

/** The panel of the selected CLI — everything Yard knows how to say about it. */
function AgentPanel({
  row,
  wsl,
  ssh,
}: {
  row: AgentDefaultRow;
  wsl: WslStatus | null;
  ssh: SshStatus | null;
}) {
  const t = useT();
  const setConfig = useAgentDefaults((s) => s.setConfig);
  const fieldId = useId();
  const nameId = useId();
  /**
   * The text is local while typing and reaches the store on leaving the field:
   * wiring the input straight to the store would put one SQLite write in the
   * path of every keystroke — the same reason the numeric rows keep a draft
   * (`rows.tsx`).
   */
  const [text, setText] = useState(row.config.args);
  const [name, setName] = useState(row.config.name);
  // The SSH host and remote folder follow the same draft rule as the name.
  const [host, setHost] = useState(row.config.sshHost);
  const [remote, setRemote] = useState(row.config.sshPath);
  const hostsId = useId();
  // What comes from outside (the switch above, another window, a restored
  // backup, switching tab) is the truth; typing does not change
  // `row.config.args`, so this never fights the field.
  useEffect(() => setText(row.config.args), [row.config.args]);
  useEffect(() => setName(row.config.name), [row.config.name]);
  useEffect(() => setHost(row.config.sshHost), [row.config.sshHost]);
  useEffect(() => setRemote(row.config.sshPath), [row.config.sshPath]);

  const on = !!row.skip && hasFlag(text, row.skip.args);
  const caches = cacheChoicesOf(row.id);
  const cache = caches?.find((c) => c.value === row.config.cache) ?? caches?.[0];
  const inWsl = row.config.where === "wsl";
  const canWsl = !!wsl?.available;
  const inSsh = row.config.where === "ssh";
  const canSsh = !!ssh?.available;

  return (
    <>
      <Card>
        {row.skip ? (
          <Row
            label={t("Sem pedir permissão")}
            desc={
              <>
                {/* The flag itself leads the line: the row has to say exactly
                    what the switch writes into the field below. */}
                <code>{row.skip.args.join(" ")}</code> · {t(row.skip.hint)}
              </>
            }
          >
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={on}
              onChange={(e) => {
                const next = withFlag(text, row.skip!.args, e.target.checked);
                setText(next);
                setConfig(row.id, { args: next });
              }}
              aria-label={t("Sem pedir permissão — {name}", { name: row.name })}
            />
          </Row>
        ) : (
          <Row
            label={t("Sem pedir permissão")}
            desc={t(
              "esta CLI não tem uma flag de permissão que a gente tenha conferido — o que ela precisar vai na linha abaixo",
            )}
          >
            <span className="set-chip">{t("sem flag")}</span>
          </Row>
        )}

        <label className="set-row set-agent-args" htmlFor={nameId}>
          <span className="set-row-text">
            <span className="set-row-label">{t("Nome da aba")}</span>
            <small className="set-row-desc">
              {t("Como a aba e o cartão vão se chamar. Vazio = o nome da CLI.")}
            </small>
          </span>
          <input
            id={nameId}
            className="set-agent-name"
            value={name}
            spellCheck={false}
            placeholder={row.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setConfig(row.id, { name })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setName(row.config.name);
            }}
          />
        </label>

        <label className="set-row set-agent-args" htmlFor={fieldId}>
          <span className="set-row-label">{t("Abre sempre com")}</span>
          <input
            id={fieldId}
            value={text}
            spellCheck={false}
            placeholder={t("opcional — ex.: --model opus --add-dir ../api")}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setConfig(row.id, { args: text })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setText(row.config.args);
            }}
          />
        </label>

        <Row
          label={t("Roda em")}
          desc={
            inWsl
              ? t(
                  "no WSL a CLI é a que estiver instalada dentro da distribuição, e a pasta do projeto entra traduzida",
                )
              : inSsh
                ? t(
                    "por SSH o processo nasce na outra máquina: a CLI é a que estiver instalada lá, e a pasta é a remota",
                  )
                : t("o processo nasce no Windows, com a CLI que o Yard detectou aqui")
          }
        >
          <div className="set-agent-pair">
            <Select
              className="set-picker"
              label={t("Onde {name} roda", { name: row.name })}
              value={row.config.where}
              // A choice that cannot work must not be clickable: with no distro
              // installed, "WSL" is a terminal that dies on `wsl.exe` with
              // nothing on screen explaining why.
              options={[
                { value: "windows", label: "Windows" }, // i18n-ok
                { value: "wsl", label: "WSL", disabled: !canWsl }, // i18n-ok
                { value: "ssh", label: "SSH", disabled: !canSsh }, // i18n-ok
              ]}
              onChange={(v) =>
                setConfig(row.id, {
                  where: v === "wsl" ? "wsl" : v === "ssh" ? "ssh" : "windows",
                })
              }
            />
            {inWsl && (
              <Select
                className="set-picker"
                label={t("Distribuição de {name}", { name: row.name })}
                value={row.config.distro || DEFAULT_DISTRO}
                options={[
                  { value: DEFAULT_DISTRO, label: t("A padrão do WSL") },
                  ...(wsl?.distros ?? []).map((d) => ({ value: d, label: d })),
                ]}
                onChange={(v) =>
                  setConfig(row.id, { distro: v === DEFAULT_DISTRO ? "" : v })
                }
              />
            )}
            {inSsh && (
              <>
                <input
                  className="set-agent-field"
                  list={hostsId}
                  value={host}
                  spellCheck={false}
                  placeholder={t("host — alias do ~/.ssh/config ou user@host")}
                  aria-label={t("Host SSH de {name}", { name: row.name })}
                  onChange={(e) => setHost(e.target.value)}
                  onBlur={() => setConfig(row.id, { sshHost: host })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setHost(row.config.sshHost);
                  }}
                />
                {/* The aliases ssh itself knows; typing anything else still works. */}
                <datalist id={hostsId}>
                  {(ssh?.hosts ?? []).map((h) => (
                    <option key={h} value={h} />
                  ))}
                </datalist>
                <input
                  className="set-agent-field set-agent-field--path"
                  value={remote}
                  spellCheck={false}
                  placeholder={t("pasta remota — vazio = a home")}
                  aria-label={t("Pasta remota de {name}", { name: row.name })}
                  onChange={(e) => setRemote(e.target.value)}
                  onBlur={() => setConfig(row.id, { sshPath: remote })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRemote(row.config.sshPath);
                  }}
                />
              </>
            )}
          </div>
        </Row>

        <Row
          label={t("Cache da conversa")}
          desc={caches && cache ? t(cache.hint) : t(cacheNoteOf(row.id))}
        >
          {caches && cache ? (
            <Select
              className="set-picker"
              label={t("Cache de {name}", { name: row.name })}
              value={cache.value}
              options={caches.map((c) => ({ value: c.value, label: t(c.label) }))}
              onChange={(v) =>
                setConfig(row.id, {
                  cache: (caches.find((c) => c.value === v) ?? caches[0]).value,
                })
              }
            />
          ) : (
            <span className="set-chip">{t("sem ajuste")}</span>
          )}
        </Row>

        <Row
          label={t("Aparecer em “Nova aba”")}
          desc={t(
            "Desligado, continua instalado e configurado aqui — só sai da grade de marcas e da lista de uma tarefa nova",
          )}
        >
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={!row.config.hidden}
            onChange={(e) => setConfig(row.id, { hidden: !e.target.checked })}
            aria-label={t("Aparecer em Nova aba — {name}", { name: row.name })}
          />
        </Row>
      </Card>

      <GroupTitle>{t("Papel")}</GroupTitle>
      <Card>
        <div className="set-agent-role">
          <RoleField
            // No group here: a default that follows the CLI everywhere can
            // only draw on the global library, which is exactly what
            // `groupId: null` means to the picker.
            groupId={null}
            hint={t(launchHint(row.id))}
            value={row.config.role}
            onChange={(pick) => setConfig(row.id, { role: pick })}
          />
        </div>
      </Card>
      <p className="hint">
        {t("Toda aba nova desta CLI nasce com esse papel — e os recrutados no canvas sem")}{" "}
        <code>--role</code> {t("também. Dá para trocar depois no menu do cartão, sem mexer aqui.")}
      </p>

      {!canWsl && inWsl && (
        <p className="hint hint--warn" role="alert">
          {wsl?.reason ?? t("o WSL não está disponível")}{" "}
          {t("— este agente vai tentar abrir assim mesmo até você trocar para Windows.")}
        </p>
      )}
      {inSsh && (
        <p className="hint">
          {t(
            "A CLI tem de estar instalada no host, e a chave SSH tem de entrar sem senha — se pedir senha, ela aparece no terminal e funciona, mas o papel e o cache não chegam antes dela. O",
          )}{" "}
          <code>yard</code>{" "}
          {t("não atravessa o SSH: a CLI remota não fala com as outras do canvas.")}
        </p>
      )}
      {!canSsh && inSsh && (
        <p className="hint hint--warn" role="alert">
          {ssh?.reason ?? t("o SSH não está disponível")}{" "}
          {t("— este agente vai tentar abrir assim mesmo até você trocar para Windows.")}
        </p>
      )}
      {inSsh && !row.config.sshHost && (
        <p className="hint hint--warn" role="alert">
          {t("Sem host não há para onde ir: a CLI não abre até você preencher o campo acima.")}
        </p>
      )}
      {!row.installed && (
        <p className="hint">
          {t(
            "Esta CLI não foi encontrada nesta máquina. O que você configurar aqui fica guardado e passa a valer assim que ela aparecer.",
          )}
        </p>
      )}
    </>
  );
}

export function SecAgents() {
  const t = useT();
  const byId = useAgents((s) => s.byId);
  const defaults = useAgentDefaults((s) => s.defaults);
  const rows = agentDefaultRows(Object.values(byId), defaults);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const open = pickAgentTab(rows, selectedId);
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * Asked once, when the screen opens. `wsl.exe` on a cold machine takes
   * seconds to answer, and a picker that starts enabled and disables itself a
   * beat later moves under the pointer — so `null` (still asking) reads as
   * "not available yet" and settles into the real answer.
   */
  const [wsl, setWsl] = useState<WslStatus | null>(null);
  // Same question, same timing, for the third place: is there an `ssh` here,
  // and which aliases does `~/.ssh/config` already name?
  const [ssh, setSsh] = useState<SshStatus | null>(null);
  useEffect(() => {
    let live = true;
    void ipc
      .sshStatus()
      .then((s) => live && setSsh(s))
      .catch(
        () =>
          live &&
          setSsh({
            available: false,
            path: null,
            hosts: [],
            reason: t("não consegui perguntar pelo ssh"),
          }),
      );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void ipc
      .wslStatus()
      .then((s) => live && setWsl(s))
      .catch(
        () =>
          live &&
          setWsl({
            available: false,
            distros: [],
            reason: t("não consegui perguntar ao WSL"),
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  /** Arrows walk the strip, as a tablist promises. */
  const onStripKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.id === open?.id);
    const next = rows[(at + (e.key === "ArrowRight" ? 1 : -1) + rows.length) % rows.length];
    if (!next) return;
    setSelectedId(next.id);
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-agent="${next.id}"]`)
      ?.focus();
  };

  return (
    <>
      <GroupTitle>{t("Como cada CLI abre")}</GroupTitle>
      {rows.length === 0 ? (
        <Card>
          <div className="set-row">
            <div className="set-row-text">
              <span className="set-row-label">{t("Nenhuma CLI de agente por aqui")}</span>
              <small className="set-row-desc">
                {t(
                  "Instale uma (Claude Code, Codex, Gemini…) e ela aparece nesta lista na próxima vez que o Yard abrir.",
                )}
              </small>
            </div>
          </div>
        </Card>
      ) : (
        <>
          <div
            className="set-agent-tabs"
            role="tablist"
            aria-label={t("Agentes")}
            ref={stripRef}
            onKeyDown={onStripKey}
          >
            {rows.map((r) => {
              const isOpen = r.id === open?.id;
              return (
                <button
                  key={r.id}
                  role="tab"
                  data-agent={r.id}
                  aria-selected={isOpen}
                  // Roving tabindex: Tab enters the strip once, arrows do the
                  // rest — nine CLIs would otherwise be nine stops.
                  tabIndex={isOpen ? 0 : -1}
                  className={`set-agent-tab ${isOpen ? "is-active" : ""} ${
                    r.config.hidden ? "is-off" : ""
                  } ${r.installed ? "" : "is-missing"}`}
                  data-tip={r.installed ? r.detail || undefined : t("não instalado")}
                  onClick={() => setSelectedId(r.id)}
                >
                  <AgentMark row={r} />
                  <span className="set-agent-tab-name">{r.name}</span>
                  {/* A dot, not a word: the strip has to stay scannable, and
                      "this one has been set up" is all it needs to say. */}
                  {!isDefaultConfig(r.config) && (
                    <i className="set-agent-dot" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
          {open && (
            <div role="tabpanel" aria-label={open.name}>
              <AgentPanel row={open} wsl={wsl} ssh={ssh} key={open.id} />
            </div>
          )}
        </>
      )}

      <p className="hint">
        {t(
          "É daqui que sai tudo o que uma aba nova daquela CLI recebe — em “Nova aba” um clique já abre, sem formulário — e também o que vai para os agentes que nascem sem diálogo nenhum: os recrutados no canvas",
        )}{" "}
        (<code>yard recruit</code>
        {t(
          "), os de uma tarefa em andares e as conversas retomadas. Quem já está aberto não muda: vale a partir do próximo início.",
        )}
      </p>
      <p className="hint">
        {t("O")} <strong>{t("cache")}</strong>{" "}
        {t(
          "só aparece como escolha nas CLIs que documentam um ajuste — hoje o Claude Code (variáveis de ambiente) e o aider (flags). O Codex faz cache sozinho e não expõe duração; nas outras a gente não achou nada documentado, e é isso que a linha delas diz, em vez de um controle que não faria nada.",
        )}
      </p>

      <GroupTitle>{t("Notificações")}</GroupTitle>
      <Card>
        <SwitchRow
          pref="notifyOnFinish"
          label={t("Notificar quando um agente terminar")}
          desc={t("Notificação nativa do Windows quando a saída fica quieta")}
        />
        <SwitchRow
          pref="notifyBlocked"
          label={t("Avisar quando um agente travar")}
          desc={t(
            "Uma pergunta, um (y/N) ou uma senha na última linha viram notificação com a pergunta dentro — o badge amarelo no cartão aparece de qualquer jeito",
          )}
        />
      </Card>
      <p className="hint">
        {t(
          "Um agente conta como “parou” depois de ~4,5 s de silêncio seguindo atividade. O silêncio diz que parou; a cauda da saída diz por quê — um menu com cursor, um (y/N) ou um Password: na última linha viram “travado” em vez de “terminou”. O balão só sai quando o painel não está à vista: o que você acabou de ver acontecer não vira notificação.",
        )}
      </p>
    </>
  );
}
