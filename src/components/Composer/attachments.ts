/** Preview local quoted attachments directly from the persistent prompt text. */
export interface PromptAttachment {
  path: string;
  name: string;
  root: string;
  image: boolean;
  start: number;
  end: number;
}

export function promptAttachments(draft: string): PromptAttachment[] {
  const out: PromptAttachment[] = [];
  for (const match of draft.matchAll(/"((?:[A-Za-z]:\/|\/)[^"\n]+)"/g)) {
    const path = match[1];
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    const root =
      cut === 0 || (cut === 2 && path[1] === ":")
        ? path.slice(0, cut + 1)
        : path.slice(0, cut);
    out.push({
      path,
      name,
      root,
      image: /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name),
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }
  return out;
}
