/**
 * The address bar holds a local draft of the url. A page that navigates on
 * its own (a redirect, a link the agent clicked) used to overwrite whatever
 * the user was typing, mid-word. The rule: the draft follows the page only
 * while nobody is typing in it.
 */
import { describe, expect, it } from "vitest";

import { resyncUrlDraft } from "./urlDraft";

describe("resyncUrlDraft", () => {
  it("keeps the user's typing when the field has focus", () => {
    expect(resyncUrlDraft("git", "https://b.example", true)).toBe("git");
  });

  it("follows the page when the field is idle", () => {
    expect(resyncUrlDraft("git", "https://b.example", false)).toBe("https://b.example");
  });
});
