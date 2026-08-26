/**
 * Automatic backups — the rule that decides when the next copy is due.
 *
 * The manual export (`Configurações → Dados e backup`) already writes a
 * `.zip`; this is the timer around it. Everything here is pure: the store
 * and the hook own the clock and the disk, this module only answers "is it
 * time?" and "how do I say when the last one was?".
 *
 * The stamp lives in the `kv` under `backup.lastAutoAt` (epoch ms as text),
 * outside `Prefs` on purpose: it is a fact about the disk, not a choice of
 * the user, and "reset preferences" must not make the app forget it.
 */
import { since, sinceKind } from "./format";
import { t } from "./i18n";

export type AutoBackupMode = "off" | "daily" | "weekly";

export const AUTO_BACKUP_MODES: readonly AutoBackupMode[] = ["off", "daily", "weekly"];

export const KV_LAST_AUTO = "backup.lastAutoAt";

const DAY_MS = 86_400_000;

/** How long a copy lasts before the next one is due; `null` while off. */
export function periodMs(mode: AutoBackupMode): number | null {
  switch (mode) {
    case "daily":
      return DAY_MS;
    case "weekly":
      return 7 * DAY_MS;
    default:
      return null;
  }
}

export interface DueInput {
  mode: AutoBackupMode;
  /** Epoch ms of the last automatic copy; `0` = never. */
  lastAt: number;
  now: number;
}

/**
 * Due when the period elapsed — or when there is no last copy at all. A stamp
 * ahead of the clock (a machine set back, a backup restored from elsewhere)
 * counts as due too: otherwise it would silence the backup for days.
 */
export function backupDue({ mode, lastAt, now }: DueInput): boolean {
  const period = periodMs(mode);
  if (period === null) return false;
  if (!lastAt || lastAt > now) return true;
  return now - lastAt >= period;
}

/** When the next copy is due — `now` when nothing was ever written, `null` when off. */
export function nextBackupAt({ mode, lastAt, now }: DueInput): number | null {
  const period = periodMs(mode);
  if (period === null) return null;
  if (!lastAt || lastAt > now) return now;
  return lastAt + period;
}

/** The kv stores text; anything that is not a positive epoch is "never". */
export function parseLastAuto(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** "nunca" · "agora" · "há 5min" · "há 2 dias" · "em 12 de jul." */
export function describeLast(lastAt: number, now: number): string {
  if (!lastAt) return t("nunca");
  const at = Math.floor(lastAt / 1000);
  // `since` answers a duration up to a month ("5min", "3h", "2 dias") and a
  // date past that ("12 de jul."); `sinceKind` says which, so the sentence
  // around it never has to read the words back.
  switch (sinceKind(at, now)) {
    case "none":
    case "now":
      return t("agora");
    case "duration":
      return t("há {s}", { s: since(at, now) });
    default:
      return t("em {s}", { s: since(at, now) });
  }
}
