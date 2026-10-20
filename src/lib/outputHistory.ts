/** Session archives stay addressable after the active terminal output is replaced. */
export interface ArchivedOutput { terminalId: string; name: string; at: number; bytes: number }
export interface ArchivedPreview { text: string; bytes: number; truncated: boolean }

export function archivePage(records: ArchivedOutput[], visible: number): { records: ArchivedOutput[]; nextLimit: number | null } {
  const limit = Math.max(1, Math.trunc(visible));
  return { records: records.slice(0, limit), nextLimit: limit < records.length ? Math.min(records.length, limit + 200) : null };
}

export function retentionCandidates(records: ArchivedOutput[], days: number, now: number): ArchivedOutput[] {
  if (days <= 0) return [];
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return records.filter((record) => record.at < cutoff);
}
