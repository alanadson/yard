export function landActions(state: {
  hasPreview: boolean;
  blocked: boolean;
  error: string | null;
  comparing: boolean;
  busy: boolean;
}) {
  return {
    canRetry:
      !state.busy && !state.comparing && (state.hasPreview || !!state.error),
    canLand:
      state.hasPreview &&
      !state.blocked &&
      !state.error &&
      !state.comparing &&
      !state.busy,
  };
}
