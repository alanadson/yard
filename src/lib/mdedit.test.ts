import { describe, expect, it } from "vitest";

import { applyMd, blockOf, enterKey, toggleTaskLine, type MdSel } from "./mdedit";

/**
 * `|` marks the caret, `«…»` a selection — reads like what the user sees.
 * Guillemets and not brackets: half of what is tested here *is* brackets.
 */
function sel(marked: string): MdSel {
  const a = marked.indexOf("«");
  if (a >= 0) {
    const b = marked.indexOf("»", a);
    return {
      value: marked.slice(0, a) + marked.slice(a + 1, b) + marked.slice(b + 1),
      start: a,
      end: b - 1,
    };
  }
  const at = marked.indexOf("|");
  return { value: marked.replace("|", ""), start: at, end: at };
}

function show(s: MdSel): string {
  if (s.start === s.end) return `${s.value.slice(0, s.start)}|${s.value.slice(s.start)}`;
  return `${s.value.slice(0, s.start)}«${s.value.slice(s.start, s.end)}»${s.value.slice(s.end)}`;
}

describe("blocks", () => {
  it("adds and removes the heading on the same key", () => {
    const once = applyMd("h2", sel("pla|no"));
    expect(once.value).toBe("## plano");
    expect(applyMd("h2", once).value).toBe("plano");
  });

  it("swaps one marker for another without stacking", () => {
    expect(applyMd("h3", sel("# ti|tulo")).value).toBe("### titulo");
    expect(applyMd("bullet", sel("> ci|tacao")).value).toBe("- citacao");
  });

  it("numbers the selected lines starting at one", () => {
    const s = sel("«um\ndois\ntres»");
    expect(applyMd("ordered", s).value).toBe("1. um\n2. dois\n3. tres");
  });

  it("preserves the indentation when marking", () => {
    expect(applyMd("task", sel("    fei|to")).value).toBe("    - [ ] feito");
  });

  it("the cursor moves along with the prefix", () => {
    expect(show(applyMd("h1", sel("pl|ano")))).toBe("# pl|ano");
  });

  it("a selection ending at the line break does not take the next line", () => {
    const s: MdSel = { value: "um\ndois", start: 0, end: 3 };
    expect(applyMd("bullet", s).value).toBe("- um\ndois");
  });

  it("blockOf sees the block under the cursor", () => {
    expect(blockOf("## titulo", 4)).toBe("h2");
    expect(blockOf("- [x] feito", 8)).toBe("task");
    expect(blockOf("- item", 3)).toBe("bullet");
    expect(blockOf("solto", 2)).toBe("paragraph");
  });
});

describe("inline markup", () => {
  // The selection stays on the content, not the asterisks: pressing Ctrl+B
  // again has to undo what just happened.
  it("wraps the selection and keeps holding the text", () => {
    expect(show(applyMd("bold", sel("um «dois» tres")))).toBe("um **«dois»** tres");
  });

  it("without a selection takes the word under the cursor", () => {
    expect(applyMd("italic", sel("um do|is tres")).value).toBe("um *dois* tres");
  });

  it("on empty opens the pair and stops in the middle", () => {
    expect(show(applyMd("code", sel("|")))).toBe("`|`");
  });

  it("removes the markup that was already there", () => {
    expect(applyMd("bold", sel("«**forte**»")).value).toBe("forte");
    expect(applyMd("bold", sel("**«forte»**")).value).toBe("forte");
  });

  it("highlight and strikethrough use obsidian's pairs", () => {
    expect(applyMd("highlight", sel("«nota»")).value).toBe("==nota==");
    expect(applyMd("strike", sel("«nota»")).value).toBe("~~nota~~");
  });
});

describe("link", () => {
  it("selected text leaves the cursor in the address", () => {
    expect(show(applyMd("link", sel("«docs»")))).toBe("[docs](|)");
  });

  it("a selected address leaves the cursor in the label", () => {
    expect(show(applyMd("link", sel("«https://a.dev»")))).toBe("[|](https://a.dev)");
  });
});

describe("code block", () => {
  it("fences the selection and keeps it selected", () => {
    expect(show(applyMd("codeblock", sel("«ls -la»")))).toBe("```\n«ls -la»\n```");
  });

  it("again, removes the fence", () => {
    const s: MdSel = { value: "```\nls\n```", start: 4, end: 6 };
    expect(applyMd("codeblock", s).value).toBe("ls");
  });
});

describe("whole lines", () => {
  it("indents and outdents two at a time", () => {
    const one = applyMd("indent", sel("- it|em"));
    expect(one.value).toBe("  - item");
    expect(applyMd("outdent", one).value).toBe("- item");
  });

  it("the rule goes below the current line", () => {
    expect(applyMd("rule", sel("no|ta")).value).toBe("nota\n---\n");
  });

  it("duplicates the line right below", () => {
    expect(applyMd("duplicate", sel("u|m\ndois")).value).toBe("um\num\ndois");
  });

  it("moves the line up and down", () => {
    expect(applyMd("moveDown", sel("u|m\ndois")).value).toBe("dois\num");
    expect(applyMd("moveUp", sel("um\ndo|is")).value).toBe("dois\num");
  });

  it("does not fall off the edges", () => {
    expect(applyMd("moveUp", sel("u|m\ndois")).value).toBe("um\ndois");
    expect(applyMd("moveDown", sel("um\ndo|is")).value).toBe("um\ndois");
  });

  it("clear removes the markup but not the text", () => {
    const s = sel("«## **um** `dois` [tres](http://a.dev)»");
    expect(applyMd("clear", s).value).toBe("um dois tres");
  });
});

describe("tasks", () => {
  it("toggles open, done and back", () => {
    expect(toggleTaskLine("- [ ] a")).toBe("- [x] a");
    expect(toggleTaskLine("- [x] a")).toBe("- [ ] a");
  });

  it("promotes a plain line to a task", () => {
    expect(toggleTaskLine("comprar")).toBe("- [ ] comprar");
    expect(toggleTaskLine("- comprar")).toBe("- [ ] comprar");
  });
});

describe("Enter", () => {
  it("continues the list", () => {
    expect(show(enterKey(sel("- um|"))!)).toBe("- um\n- |");
  });

  it("numbers the next one", () => {
    expect(show(enterKey(sel("3. um|"))!)).toBe("3. um\n4. |");
  });

  it("the next task is born open", () => {
    expect(show(enterKey(sel("- [x] um|"))!)).toBe("- [x] um\n- [ ] |");
  });

  it("on an empty item, leaves the list", () => {
    expect(show(enterKey(sel("- um\n- |"))!)).toBe("- um\n|");
  });

  it("outside a list, lets the field do its job", () => {
    expect(enterKey(sel("texto|"))).toBeNull();
  });
});

// The commands only a file has — a canvas note never gets a table.

describe("document commands", () => {
  it("heading goes up to six and back to paragraph on the same key", () => {
    const six = applyMd("h6", sel("li|nha"));
    expect(six.value).toBe("###### linha");
    expect(applyMd("h6", six).value).toBe("linha");
    expect(blockOf(six.value, 8)).toBe("h6");
    expect(blockOf("#### a", 5)).toBe("h4");
  });

  it("image: the text becomes alt, the path becomes src", () => {
    expect(show(applyMd("image", sel("«print»")))).toBe("![print](|)");
    expect(show(applyMd("image", sel("«docs/a.png»")))).toBe("![|](docs/a.png)");
  });

  it("a table is born with a header and the selected text titles the column", () => {
    const emptyOne = applyMd("table", sel("|"));
    expect(emptyOne.value.split("\n")[0]).toBe("| Coluna 1 | Coluna 2 | Coluna 3 |");
    expect(emptyOne.value.split("\n")[1]).toBe("| --- | --- | --- |");

    const withText = applyMd("table", sel("«Spec»"));
    expect(withText.value).toContain("| Spec | Coluna 2 | Coluna 3 |");
  });

  it("a footnote marks here and defines at the end, without repeating a number", () => {
    const one = applyMd("footnote", sel("texto|"));
    expect(one.value).toBe("texto[^1]\n\n[^1]: ");
    // The caret lands at the end, ready to type the explanation.
    expect(one.start).toBe(one.value.length);

    const two = applyMd("footnote", { ...one, start: 5, end: 5 });
    expect(two.value).toContain("texto[^2][^1]");
    expect(two.value.endsWith("[^2]: ")).toBe(true);
  });

  it("clear also removes the image, without leaving the exclamation mark", () => {
    expect(applyMd("clear", sel("«![alt](a.png)»")).value).toBe("alt");
  });
});
