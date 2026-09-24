/**
 * Picking (and writing) the role a CLI is born with.
 *
 * Two controls in one because they are one decision: the list is the library
 * of roles already written, and the same block turns into the editor when the
 * one you want is not in it yet. Everything happens inside whatever dialog
 * hosts this — walking off to a "manage roles" screen mid-creation would throw
 * away the terminal being set up.
 *
 * The hint under the list is not decoration: it says *how* the instructions
 * are going to reach this particular CLI, which changes with the CLI. See
 * `lib/roles.ts` for why there are two ways.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { Select } from "../Select";
import { ask } from "../../lib/confirmation";
import { roleDraftError } from "../../lib/roleDraft";
import { useT } from "../../hooks/useT";
import { useDraftExit } from "../../hooks/useDraftExit";
import { commitCanvasExternal } from "../../lib/canvasWrite";
import { CANVAS_COLORS, ROLE_NAME_MAX, type RolePreset } from "../../lib/canvas";
import { setEntry } from "../../lib/canvasOps";
import {
  deleteGlobalRole,
  groupRoles,
  mergeRoles,
  readGlobalRoles,
  writeGlobalRole,
  roleNameConflict,
  type RolePick,
  type RoleScope,
  type SavedRole,
} from "../../lib/roles";
import { useProjects } from "../../stores/projectsStore";

interface Props {
  /** Where "só neste grupo" saves to. Null = only the global library exists. */
  groupId: string | null;
  /**
   * How the instructions will reach the CLI, in one line. The caller supplies
   * it because only the caller knows which CLI: on the way in from "new
   * terminal" it has not been clicked yet.
   */
  hint: string;
  value: RolePick | null;
  onChange: (pick: RolePick | null) => void;
  onDraftChange?: (active: boolean) => void;
}

/** The option that stands for a role that is set but not in the library. */
const INLINE = " inline";

interface Draft {
  /** Name it had when the editor opened, so a rename can drop the old entry. */
  original: string | null;
  originalScope: RoleScope | null;
  name: string;
  text: string;
  scope: RoleScope;
  color: string | null;
}

export function RoleField({ groupId, hint, value, onChange, onDraftChange }: Props) {
  const t = useT();
  const canvas = useProjects((s) => (groupId ? s.layoutOf(groupId).canvas : undefined));
  const [global, setGlobal] = useState<Record<string, RolePreset>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setError] = useState<string | null>(null);
  const errorId = useId();
  const [invalidField, setInvalidField] = useState<"name" | "text" | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const discardDraft = useDraftExit(!!draft, () => setDraft(null));
  useEffect(() => { onDraftChange?.(!!draft); }, [!!draft, onDraftChange]);

  const reload = async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setGlobal(await readGlobalRoles());
      setError(null);
    } catch (e) {
      setLoadFailed(true);
      setError(t("Não consegui carregar os papéis: {e}", { e: String(e) }));
    } finally { setLoading(false); }
  };
  useEffect(() => { void reload(); }, []);

  const lib = useMemo(
    () => mergeRoles(groupRoles(canvas), global),
    [canvas, global],
  );

  /** The library entry the current pick came from, when it came from one. */
  const selected = value
    ? lib.find((r) => r.name.toLowerCase() === value.role.name.toLowerCase())
    : undefined;
  const selectValue = value ? (selected?.name ?? INLINE) : "";

  const options = [
    { value: "", label: t("Sem papel") },
    ...(value && !selected
      ? [{ value: INLINE, label: t("{name} (não salvo)", { name: value.role.name }) }]
      : []),
    ...lib.map((r) => ({
      value: r.name,
      label: r.name,
      group: r.scope === "current" ? t("Neste grupo") : t("Em todo o Yard"),
    })),
  ];

  const pick = (saved: SavedRole) =>
    onChange({ role: { name: saved.name, text: saved.text }, color: saved.color });

  const choose = (name: string) => {
    if (name === INLINE) return;
    if (!name) return onChange(null);
    const saved = lib.find((r) => r.name === name);
    if (saved) pick(saved);
  };

  const next = () => {
    setError(null);
    setDraft({
      original: null,
      originalScope: null,
      name: "",
      text: "",
      // The group is the honest default: a role written while opening one
      // terminal is usually about the work in front of the user, not a habit.
      scope: groupId ? "current" : "global",
      color: null,
    });
  };

  const edit = () => {
    if (!value) return;
    setError(null);
    setDraft({
      original: selected?.name ?? null,
      originalScope: selected?.scope ?? null,
      name: value.role.name,
      text: value.role.text ?? "",
      scope: selected?.scope ?? (groupId ? "current" : "global"),
      color: value.color ?? selected?.color ?? null,
    });
  };

  const removeFromGroup = (name: string) => {
    if (!groupId) return;
    commitCanvasExternal(groupId, (c) => ({
      ...c,
      rolePresets: setEntry(c.rolePresets, name, undefined),
    }));
  };

  const save = async () => {
    if (!draft || saving || loading || (draft.scope === "global" && loadFailed)) return;
    const name = draft.name.trim();
    const text = draft.text.trim();
    const invalid = roleDraftError(name, text);
    setInvalidField(invalid?.field ?? null);
    if (invalid) {
      setError(invalid.message);
      (invalid.field === "name" ? nameRef.current : textRef.current)?.focus();
      return;
    }

    const preset: RolePreset = draft.color ? { text, color: draft.color } : { text };
    setSaving(true);
    try {
      const destination = draft.scope === "global" ? await readGlobalRoles() : groupRoles(canvas);
      const conflict = roleNameConflict(destination, name, draft.originalScope === draft.scope ? draft.original : null);
      if (conflict && !(await ask(t('Já existe um papel chamado "{name}" neste local. Substituir suas instruções? Para manter ambos, cancele e escolha outro nome.', { name: conflict }), {
        title: t("Substituir papel"), kind: "warning", okLabel: t("Substituir"), cancelLabel: t("Escolher outro nome"),
      }))) return;
      if (draft.scope === "current" && groupId) {
        commitCanvasExternal(groupId, (c) => ({
          ...c,
          rolePresets: { ...setEntry(c.rolePresets, conflict ?? name, undefined), [name]: preset },
        }));
      } else {
        await writeGlobalRole(name, preset);
        if (conflict && conflict !== name) await deleteGlobalRole(conflict);
      }
      // A rename (or a move between scopes) would otherwise leave the previous
      // entry behind, and the list would offer the same role twice.
      if (draft.original && (draft.original !== name || draft.originalScope !== draft.scope)) {
        if (draft.originalScope === "current") removeFromGroup(draft.original);
        else await deleteGlobalRole(draft.original);
      }
    } catch (e) {
      // The global library is a row in SQLite: a failed write must say so
      // here, not leave the dialog looking like it saved.
      return setError(t("Não consegui salvar: {e}", { e: String(e) }));
    } finally {
      setSaving(false);
    }
    void reload();
    onChange({ role: { name, text }, color: draft.color ?? undefined });
    setDraft(null);
    setError(null);
  };

  /**
   * Out of the library, but still on the terminal being set up: the role does
   * not stop being this agent's job because nobody wants to reuse it. It
   * simply becomes the "(não salvo)" entry until it is saved again.
   */
  const remove = async () => {
    if (!selected || saving || loading) return;
    setSaving(true);
    try {
      if (selected.scope === "current") removeFromGroup(selected.name);
      else await deleteGlobalRole(selected.name);
    } catch (e) {
      return setError(t("Não consegui excluir: {e}", { e: String(e) }));
    } finally {
      setSaving(false);
    }
    void reload();
    setDraft(null);
  };

  return (
    <section className="role-field" aria-busy={loading || saving}>
      {loading && <p className="hint" role="status">{t("Carregando papéis…")}</p>}
      {err && <p id={errorId} className="hint hint--error" role="alert">{err}</p>}
      {loadFailed && <button type="button" className="btn" onClick={() => void reload()}>{t("Tentar novamente")}</button>}
      <fieldset className="form-fieldset" disabled={loading || saving}>
      <div className="role-field-row">
        <label className="grow">
          {t("Papel do agente")}
          <Select
            value={selectValue}
            disabled={!!draft}
            options={options}
            placeholder={t("Sem papel")}
            onChange={choose}
          />
        </label>
        <button
          type="button"
          className="icon-btn"
          data-tip={t("Novo papel")}
          aria-label={t("Novo papel")}
          onClick={next}
          disabled={!!draft}
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tip={t("Editar este papel")}
          aria-label={t("Editar este papel")}
          disabled={!value || !!draft}
          onClick={edit}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--danger"
          data-tip={t("Excluir da biblioteca")}
          aria-label={t("Excluir da biblioteca")}
          disabled={!selected || !!draft}
          onClick={() => void remove()}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <p className="hint">
        {value?.role.text
          ? hint
          : t("Uma responsabilidade fixa: o agente já nasce sabendo o que é dele.")}
      </p>

      {draft && (
        <div className="role-editor">
          <label>
            {t("Nome")}
            <input
              autoFocus
              value={draft.name}
              ref={nameRef}
              aria-invalid={invalidField === "name" || undefined}
              aria-describedby={err ? errorId : undefined}
              maxLength={ROLE_NAME_MAX}
              placeholder={t("ex.: Revisora de PR")}
              onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setInvalidField(null); setError(null); }}
            />
          </label>
          <label>
            {t("Instruções")}
            <textarea
              rows={5}
              value={draft.text}
              ref={textRef}
              aria-invalid={invalidField === "text" || undefined}
              aria-describedby={err ? errorId : undefined}
              placeholder={t("O que este agente cuida, o que evita, como responde…")}
              onChange={(e) => { setDraft({ ...draft, text: e.target.value }); setInvalidField(null); setError(null); }}
            />
          </label>
          <div className="role-editor-row">
            <label>
              {t("Onde fica")}
              <Select
                value={draft.scope}
                options={[
                  {
                    value: "current",
                    label: t("Só neste grupo"),
                    disabled: !groupId,
                  },
                  { value: "global", label: t("Em todo o Yard") },
                ]}
                onChange={(v) => setDraft({ ...draft, scope: v as RoleScope })}
              />
            </label>
            <div className="picker-field">
              <span className="picker-label" id="role-cor">
                {t("Cor do cartão")}
              </span>
              <div className="color-row" role="radiogroup" aria-labelledby="role-cor">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.color === null}
                  aria-label={t("Sem cor")}
                  data-tip={t("Sem cor")}
                  className={`color-dot color-dot--none ${
                    draft.color === null ? "is-active" : ""
                  }`}
                  onClick={() => setDraft({ ...draft, color: null })}
                />
                {CANVAS_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === c}
                    aria-label={c}
                    data-tip={c}
                    className={`color-dot ${draft.color === c ? "is-active" : ""}`}
                    style={{ background: c }}
                    onClick={() => setDraft({ ...draft, color: c })}
                  />
                ))}
              </div>
            </div>
          </div>


          <div className="role-editor-foot">
            <button type="button" className="btn" onClick={discardDraft}>
              {t("Cancelar")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={draft.scope === "global" && loadFailed}
              onClick={() => void save()}
            >
              {saving ? t("Salvando…") : t("Salvar papel")}
            </button>
          </div>
        </div>
      )}
      </fieldset>
    </section>
  );
}
