/**
 * Each "isolated" portal gets a WebView2 profile folder of its own, and a
 * profile is a browser process tree: a board of portals created with the old
 * default ran one per card. New portals now share the project's profile; a
 * card saved without the field keeps reading as isolated, so nobody's
 * existing logins move.
 */
import { describe, expect, it } from "vitest";

import { NEW_PORTAL_STORAGE, PORTAL_STORAGE_OPTIONS } from "./portalDefaults";

describe("portal storage defaults", () => {
  it("starts a new portal in the project's shared profile, one of the choices the picker offers", () => {
    expect(NEW_PORTAL_STORAGE).toBe("workspace");
    expect(PORTAL_STORAGE_OPTIONS.map((option) => option.value)).toContain(NEW_PORTAL_STORAGE);
  });
});
