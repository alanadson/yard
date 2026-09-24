import { outline, parseDoc, stats } from "../../lib/mddoc";

function parseMarkdownDocument(source: { readonly text: string }) {
  const blocks = parseDoc(source.text);
  return {
    text: source.text,
    blocks,
    headings: outline(blocks),
    counts: stats(source.text),
  };
}

const parsed = new WeakMap<object, ReturnType<typeof parseMarkdownDocument>>();

/** Sharing does not retain closed documents or superseded text revisions. */
export function markdownDocument(source: { readonly text: string }) {
  const cached = parsed.get(source);
  if (cached) return cached;
  const model = parseMarkdownDocument(source);
  parsed.set(source, model);
  return model;
}
