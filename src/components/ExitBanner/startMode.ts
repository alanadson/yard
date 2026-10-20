/** A fresh conversation gets its own active output while continuations keep theirs. */
export function keepOutputOnStart(canContinueConversation: boolean, continueConversation: boolean): boolean {
  return continueConversation || !canContinueConversation;
}
