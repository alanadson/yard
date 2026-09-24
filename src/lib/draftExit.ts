export async function exitWithDraft(
  dirty: boolean,
  confirm: () => Promise<boolean>,
  close: () => void,
): Promise<void> {
  if (!dirty || (await confirm())) close();
}
