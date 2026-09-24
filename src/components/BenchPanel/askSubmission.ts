/** Null means success; all other outcomes retain the question and its draft. */
export async function submitQuestion(
  value: string,
  allowEmpty: boolean,
  perform: (value: string) => Promise<string | null>,
  close: () => void,
): Promise<string | null> {
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) return "required";
  try {
    const error = await perform(trimmed);
    if (error) return error;
    close();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
