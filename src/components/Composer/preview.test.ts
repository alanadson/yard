/** Image previews must open file metadata so the local media protocol can serve the root. */
import { expect, it, vi } from "vitest";

vi.mock("../../lib/ipc", () => ({
  ipc: {
    fsReadText: async (root: string, path: string) => {
      if (root !== "C:/Pictures" || path !== "preview.png")
        throw new Error("File unavailable");
      return { media: "image/png", modifiedAt: 42 };
    },
  },
}));

import { loadAttachmentPreview } from "./preview";

it("opens the image file and uses its current version in the preview address", async () => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  await expect(
    loadAttachmentPreview("C:/Pictures", "preview.png"),
  ).resolves.toBe(
    "http://yardfile.localhost/?root=C%3A%2FPictures&path=preview.png&v=42",
  );
  await expect(
    loadAttachmentPreview("C:/Pictures", "missing.png"),
  ).rejects.toThrow("File unavailable");
  vi.unstubAllGlobals();
});
