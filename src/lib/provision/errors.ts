/**
 * Every way opening a front can be refused, with a stable name.
 *
 * What used to reach the screen was `git`'s own stderr — "fatal: 'main' is
 * already checked out at '/c/…'" — a sentence naming a path nobody typed, in
 * a language the app does not speak, carrying no way forward. Worse, it was
 * *one* string: the dialog could not tell "you have to pick another branch"
 * from "the disk is full", so it offered the same nothing for both.
 *
 * So each refusal is a **code**. The code is the contract: the button reads
 * it to know whether to block, the progress screen reads it to know whether
 * "Tentar de novo" has any chance, the log reads it to be greppable. The
 * sentence beside it is for the person and may be rewritten at will.
 *
 * The table is Portuguese and module-level, like every other table in this
 * app; it goes through `t()` at the moment it is drawn (`issueText`), which
 * is what lets the language flip under a dialog that is already open.
 */
import { t, type Vars } from "../i18n";

/** The field a refusal points at, when it points at one. */
export type IssueField = "name" | "branch" | "base" | "path" | "worktree" | "agent";

/**
 * `error` blocks the button; `warning` is read, acknowledged and passed.
 * Nothing here is a "soft error": a refusal either stops the work or does
 * not, and a dialog that greys the button over a warning teaches people to
 * stop reading them.
 */
type Severity = "error" | "warning";

interface Entry {
  severity: Severity;
  /** Worth pressing the same button again, unchanged? */
  retryable: boolean;
  field?: IssueField;
  /** pt-BR, with `{placeholders}` — translated where it is drawn. */
  text: string;
}

const CATALOG = {
  // --- the plan itself -----------------------------------------------------
  PLAN_STALE: {
    severity: "error",
    retryable: true,
    text: "O repositório mudou depois que este plano foi montado. Revalide antes de criar.",
  },
  OPERATION_CANCELLED: {
    severity: "error",
    retryable: true,
    text: "Cancelado antes de terminar.",
  },
  ROLLBACK_INCOMPLETE: {
    severity: "error",
    retryable: false,
    text: "Não consegui desfazer tudo: {detail}",
  },

  // --- the project ---------------------------------------------------------
  NOT_A_REPO: {
    severity: "warning",
    retryable: false,
    text: "Esta pasta não é um repositório git: a frente vai dividir o diretório do chão, sem isolamento.",
  },
  REPO_WITHOUT_COMMIT: {
    severity: "error",
    retryable: false,
    text: "O repositório ainda não tem nenhum commit — faça o primeiro antes de abrir uma frente.",
  },

  // --- identity ------------------------------------------------------------
  NAME_REQUIRED: {
    severity: "error",
    retryable: false,
    field: "name",
    text: "Dê um nome à frente.",
  },
  NAME_TAKEN: {
    severity: "error",
    retryable: false,
    field: "name",
    text: 'Já existe um grupo ou frente com o nome "{name}" neste projeto.',
  },

  // --- branches ------------------------------------------------------------
  BRANCH_INVALID: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: '"{branch}" não é um nome de branch que o git aceite.',
  },
  BRANCH_ALREADY_EXISTS: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: "A branch {branch} já existe. Escolha outro nome, ou abra a frente sobre ela como branch existente.",
  },
  BRANCH_ALREADY_CHECKED_OUT: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: "A branch {branch} já está aberta em {path}. O git só dá um worktree por branch.",
  },
  BRANCH_REQUIRED: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: "Escolha a branch existente.",
  },
  BRANCH_MISSING: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: "A branch {branch} não existe mais neste repositório.",
  },
  BASE_UNRESOLVED: {
    severity: "error",
    retryable: false,
    field: "base",
    text: "Não consegui resolver {base} para um commit.",
  },

  // --- worktrees -----------------------------------------------------------
  WORKTREE_PATH_CONFLICT: {
    severity: "error",
    retryable: false,
    field: "path",
    text: "Já existe alguma coisa em {path}.",
  },
  WORKTREE_REQUIRED: {
    severity: "error",
    retryable: false,
    field: "worktree",
    text: "Escolha o worktree que a frente vai adotar.",
  },
  WORKTREE_MISSING: {
    severity: "error",
    retryable: false,
    field: "worktree",
    text: "O git não lista mais um worktree em {path}.",
  },
  WORKTREE_ADOPTED: {
    severity: "error",
    retryable: false,
    field: "worktree",
    text: 'A frente "{name}" já trabalha nesse worktree.',
  },
  WORKTREE_LOCKED: {
    severity: "error",
    retryable: false,
    field: "worktree",
    text: "Esse worktree está travado (`git worktree lock`): {reason}",
  },
  WORKTREE_DIRTY: {
    severity: "warning",
    retryable: false,
    field: "worktree",
    text: "Esse worktree tem alterações não commitadas. O agente começa em cima delas.",
  },
  WORKTREE_SHARED: {
    severity: "warning",
    retryable: false,
    text: "Já há agente trabalhando neste destino. Dois processos no mesmo diretório se atropelam: o git não isola um do outro.",
  },
  GROUND_IN_USE: {
    severity: "warning",
    retryable: false,
    text: "O chão é a cópia que você tem aberta. O agente vai editar os mesmos arquivos que você.",
  },

  // --- the batch -----------------------------------------------------------
  ITEM_NAME_COLLISION: {
    severity: "error",
    retryable: false,
    field: "name",
    text: 'Dois agentes desta leva pedem o nome "{name}".',
  },
  ITEM_BRANCH_COLLISION: {
    severity: "error",
    retryable: false,
    field: "branch",
    text: "Dois agentes desta leva pedem a branch {branch}.",
  },
  ITEM_PATH_COLLISION: {
    severity: "error",
    retryable: false,
    field: "path",
    text: "Dois agentes desta leva pedem a pasta {path}.",
  },

  // --- the agent -----------------------------------------------------------
  AGENT_UNAVAILABLE: {
    severity: "error",
    retryable: false,
    field: "agent",
    text: "{agent} não está instalado nesta máquina.",
  },
  AGENT_LAUNCH_FAILED: {
    severity: "error",
    retryable: true,
    field: "agent",
    text: "A frente existe, mas o agente não subiu: {detail}",
  },
  SETUP_FAILED: {
    severity: "warning",
    retryable: true,
    text: "O setup da frente falhou: {detail}",
  },
  PROVISION_FAILED: {
    severity: "error",
    retryable: true,
    text: "{detail}",
  },
} as const satisfies Record<string, Entry>;

export type ProvisionCode = keyof typeof CATALOG;

/** Every code, for the tests and for anyone enumerating the catalogue. */
export const CODES = Object.keys(CATALOG) as ProvisionCode[];

export interface ProvisionIssue {
  code: ProvisionCode;
  /** The field to focus, copied from the catalogue so callers need not look. */
  field?: IssueField;
  vars?: Vars;
}

export function issue(code: ProvisionCode, vars?: Vars): ProvisionIssue {
  const entry: Entry = CATALOG[code];
  return { code, ...(entry.field ? { field: entry.field } : {}), ...(vars ? { vars } : {}) };
}

/** The sentence, in the language in force *now* — not when the issue was made. */
export function issueText(i: ProvisionIssue): string {
  return t(CATALOG[i.code].text, i.vars);
}

export function isBlocking(i: ProvisionIssue): boolean {
  return CATALOG[i.code].severity === "error";
}

export function isRetryable(i: ProvisionIssue): boolean {
  return CATALOG[i.code].retryable;
}

/** What stops the button. */
export function blockers(list: readonly ProvisionIssue[]): ProvisionIssue[] {
  return list.filter(isBlocking);
}

/** What is only to be read — in the order it was found. */
export function notices(list: readonly ProvisionIssue[]): ProvisionIssue[] {
  return list.filter((i) => !isBlocking(i));
}
