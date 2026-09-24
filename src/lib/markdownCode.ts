/** Wrap arbitrary text in a Markdown code span without closing its own fence. */
export function inlineCode(content: string): string {
  let longest = 0;
  let run = 0;
  for (const char of content) {
    if (char !== "`") {
      run = 0;
      continue;
    }
    run += 1;
    if (run > longest) longest = run;
  }
  const fence = "`".repeat(longest + 1);
  const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}
