/** Attachment previews follow the saved draft, so changing terminals cannot lose them. */
import { expect, it } from "vitest";
import { promptAttachments } from "./attachments";

it("keeps the filesystem root when an attached image is directly inside it", () => {
  expect(
    promptAttachments('"C:/screen.png" "/screen.png"').map((item) => item.root),
  ).toEqual(["C:/", "/"]);
});

it("finds a quoted image among text and file attachments without fetching web URLs", () => {
  const draft =
    'Compare "C:/My Project/screen.png" with "C:/My Project/spec.md" and "https://example.com/private.png"';
  expect(promptAttachments(draft)).toEqual([
    {
      path: "C:/My Project/screen.png",
      name: "screen.png",
      root: "C:/My Project",
      image: true,
      start: 8,
      end: 34,
    },
    {
      path: "C:/My Project/spec.md",
      name: "spec.md",
      root: "C:/My Project",
      image: false,
      start: 40,
      end: 63,
    },
  ]);
});
