/**
 * The address bar's draft after the page moved on its own (a redirect, a
 * link the agent clicked). It follows the page only while nobody is typing
 * in it: a navigation must not erase an address mid-word.
 */
export function resyncUrlDraft(draft: string, url: string, focused: boolean): string {
  return focused ? draft : url;
}
