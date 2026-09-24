// Preview, outline and counts must describe the same live document revision.
import { describe, expect, it } from "vitest";
import { markdownDocument } from "./markdownDocument";

describe("the live Markdown document", () => {
  it("shares one parsed result between consumers of the same source revision", () => {
    const source = { text: "# Shared\n\nA paragraph." };
    const preview = markdownDocument(source);
    expect(markdownDocument(source)).toBe(preview);
    expect(markdownDocument({ text: "# Independent" }).headings[0].text).toBe(
      "Independent",
    );
    expect(markdownDocument(source)).toBe(preview);
  });

  it("follows consecutive text revisions while the document remains dirty", () => {
    const saved = "# Original";
    const first = { saved, text: "# First" };
    expect(markdownDocument(first).headings[0].text).toBe("First");
    const next = { ...first, text: "# Second\n\n- [x] Finished" };
    const model = markdownDocument(next);
    expect(model.headings[0].text).toBe("Second");
    expect(model.blocks[0]).toMatchObject({ t: "h", line: 0 });
    expect(model.counts.tasks).toEqual({ done: 1, total: 1 });
    expect(model.text).toBe(next.text);
  });
});
