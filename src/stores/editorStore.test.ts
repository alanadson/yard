/**
 * The editor shares the disk with the agents: what the watcher feed does to
 * an open file (reload, warn, mark as gone) and what a write does when the
 * disk moved underneath are the heart of the store — and the place where a
 * mistake costs the text someone wrote.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirListing } from "../lib/ipc";
import {
  ancestors,
  docId,
  isDirty,
  joinPath,
  parentDir,
  parseStoredDocs,
  serializeDocs,
  tabLabel,
  useEditor,
  type OpenDoc,
} from "./editorStore";

const fsReadText = vi.fn();
const fsWriteText = vi.fn();
const fsRenameEntry = vi.fn();
const fsListDir = vi.fn(
  async (...args: unknown[]): Promise<DirListing> => ({
    path: String(args[1] ?? ""),
    entries: [],
    dropped: 0,
  }),
);
const readPrefs = vi.fn(async (): Promise<Record<string, string>> => ({}));
const writePref = vi.fn(async () => {});

vi.mock("../lib/ipc", () => ({
  ipc: {
    fsReadText: (...args: unknown[]) => fsReadText(...args),
    fsWriteText: (...args: unknown[]) => fsWriteText(...args),
    fsRenameEntry: (...args: unknown[]) => fsRenameEntry(...args),
    fsListDir: (...args: unknown[]) => fsListDir(...args),
    readPrefs: () => readPrefs(),
    writePref: (...args: unknown[]) => writePref(...(args as [])),
  },
}));

vi.mock("../lib/log", () => ({
  uiLog: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

function doc(path: string, patch: Partial<OpenDoc> = {}): OpenDoc {
  const root = patch.root ?? "C:\\proj";
  return {
    id: patch.id ?? docId(root, path),
    projectId: patch.projectId ?? "p1",
    groupId: patch.groupId ?? "g1",
    slot: patch.slot ?? 0,
    root,
    path,
    text: "original",
    saved: "original",
    diskVersion: 1,
    modifiedAt: 1000,
    crlf: false,
    bom: false,
    binary: false,
    truncated: false,
    lossy: false,
    size: 8,
    media: null,
    stale: false,
    missing: false,
    error: null,
    saving: false,
    ...patch,
  };
}

function activity(paths: { path: string; kind: "created" | "modified" | "deleted" }[]) {
  return {
    projectId: "p1",
    root: "C:\\proj",
    events: paths.map((p) => ({ ...p, at: 0 })),
    dropped: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useEditor.setState({
    projectId: "p1",
    root: "C:\\proj",
    dirs: {},
    expanded: {},
    loading: {},
    dirError: {},
    docs: [],
    activeId: null,
    open: false,
  });
});

describe("paths", () => {
  it("parent directory and lineage", () => {
    expect(parentDir("src/lib/canvas.ts")).toBe("src/lib");
    expect(parentDir("README.md")).toBe("");
    expect(ancestors("src/lib/canvas.ts")).toEqual(["src", "src/lib"]);
    expect(ancestors("README.md")).toEqual([]);
    expect(joinPath("", "a.ts")).toBe("a.ts");
    expect(joinPath("src", "a.ts")).toBe("src/a.ts");
  });

  it("the tab shows the folder when two files share a name", () => {
    const openDocs = [doc("src/a/index.tsx"), doc("src/b/index.tsx"), doc("src/App.tsx")];
    expect(tabLabel(openDocs[0], openDocs)).toBe("a/index.tsx");
    expect(tabLabel(openDocs[2], openDocs)).toBe("App.tsx");
  });
});

describe("the disk changed from outside", () => {
  it("an open, untouched file follows the agent", async () => {
    fsReadText.mockResolvedValue({
      path: "a.ts",
      text: "escrito pelo agente",
      binary: false,
      truncated: false,
      size: 20,
      modifiedAt: 2000,
      crlf: false,
    });
    useEditor.setState({ docs: [doc("a.ts")] });

    useEditor.getState().applyActivity(activity([{ path: "a.ts", kind: "modified" }]));
    await vi.waitFor(() => {
      expect(useEditor.getState().docs[0].text).toBe("escrito pelo agente");
    });
    const current = useEditor.getState().docs[0];
    expect(isDirty(current)).toBe(false);
    expect(current.modifiedAt).toBe(2000);
  });

  it("a file with a draft only warns — the user's text stays", () => {
    useEditor.setState({ docs: [doc("a.ts", { text: "meu rascunho" })] });

    useEditor.getState().applyActivity(activity([{ path: "a.ts", kind: "modified" }]));

    const currentValue = useEditor.getState().docs[0];
    expect(currentValue.text).toBe("meu rascunho");
    expect(currentValue.stale).toBe(true);
    expect(fsReadText).not.toHaveBeenCalled();
  });

  it("deleted from outside becomes a warning, not a loss", () => {
    useEditor.setState({ docs: [doc("a.ts", { text: "meu rascunho" })] });

    useEditor.getState().applyActivity(activity([{ path: "a.ts", kind: "deleted" }]));

    const current = useEditor.getState().docs[0];
    expect(current.missing).toBe(true);
    expect(current.text).toBe("meu rascunho");
  });

  it("another project's feed changes nothing", () => {
    useEditor.setState({ docs: [doc("a.ts")] });
    useEditor.getState().applyActivity({
      ...activity([{ path: "a.ts", kind: "modified" }]),
      projectId: "outro",
    });
    expect(fsReadText).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("a conflict preserves the draft and lights the warning", async () => {
    fsWriteText.mockRejectedValue(
      "CONFLITO: o arquivo mudou no disco desde que você o abriu",
    );
    useEditor.setState({ docs: [doc("a.ts", { text: "meu texto" })] });

    const ok = await useEditor.getState().save(docId("C:\\proj", "a.ts"));

    expect(ok).toBe(false);
    const current = useEditor.getState().docs[0];
    expect(current.text).toBe("meu texto");
    expect(current.saved).toBe("original");
    expect(current.stale).toBe(true);
  });

  it("saving sends the stamp the editor saw and adopts the new one", async () => {
    fsWriteText.mockResolvedValue({ modifiedAt: 4242, size: 9 });
    useEditor.setState({ docs: [doc("a.ts", { text: "meu texto" })] });

    await useEditor.getState().save(docId("C:\\proj", "a.ts"));

    // The stamp is the pair (mtime, size): the clock's 1 s tolerance does not
    // cover an agent rewriting the file within the same second.
    expect(fsWriteText).toHaveBeenCalledWith(
      "C:\\proj",
      "a.ts",
      "meu texto",
      { modifiedAt: 1000, size: 8 },
      false,
      false,
    );
    const current = useEditor.getState().docs[0];
    expect(isDirty(current)).toBe(false);
    expect(current.modifiedAt).toBe(4242);
    expect(current.size).toBe(9);
  });

  /**
   * The regression this locks: the BOM was stripped on read and never put
   * back on write, so saving a `.ps1` through the tree shortened the file by
   * three bytes — and PowerShell 5.1 starts reading the script as ANSI. The
   * `bom` travels with the `crlf`, down the same path and under the same
   * contract.
   */
  it("saving gives the BOM back to a file that had one", async () => {
    fsWriteText.mockResolvedValue({ modifiedAt: 4242, size: 12 });
    useEditor.setState({
      docs: [doc("script.ps1", { text: "editado", bom: true, crlf: true })],
    });

    await useEditor.getState().save(docId("C:\\proj", "script.ps1"));

    expect(fsWriteText).toHaveBeenCalledWith(
      "C:\\proj",
      "script.ps1",
      "editado",
      { modifiedAt: 1000, size: 8 },
      true,
      true,
    );
  });

  it("overwriting gives the BOM back too", async () => {
    fsWriteText.mockResolvedValue({ modifiedAt: 4242, size: 12 });
    useEditor.setState({
      docs: [doc("script.ps1", { text: "editado", bom: true, stale: true })],
    });

    await useEditor.getState().overwrite(docId("C:\\proj", "script.ps1"));

    expect(fsWriteText).toHaveBeenCalledWith(
      "C:\\proj",
      "script.ps1",
      "editado",
      null,
      false,
      true,
    );
  });

  it("a truncated file is not written (it would cut off the rest)", async () => {
    useEditor.setState({
      docs: [doc("grande.log", { text: "editado", truncated: true })],
    });
    expect(await useEditor.getState().save(docId("C:\\proj", "grande.log"))).toBe(false);
    expect(fsWriteText).not.toHaveBeenCalled();
  });

  /**
   * A cp1252 file has no zero byte, so it passes the binary test and arrives
   * here as text — only already decoded with loss. Writing the buffer would
   * put `U+FFFD` over every accent, across the whole file.
   */
  it("a non-UTF-8 file is not written (it would destroy the original bytes)", async () => {
    useEditor.setState({
      docs: [doc("legado.txt", { text: "cora\ufffd\ufffdo editado", lossy: true })],
    });
    expect(await useEditor.getState().save(docId("C:\\proj", "legado.txt"))).toBe(false);
    expect(await useEditor.getState().overwrite(docId("C:\\proj", "legado.txt"))).toBe(false);
    expect(fsWriteText).not.toHaveBeenCalled();
  });
});

describe("tabs", () => {
  it("renaming takes along what is open, including inside the folder", async () => {
    fsRenameEntry.mockResolvedValue(undefined);
    useEditor.setState({
      docs: [doc("src/velho/a.ts"), doc("outro.ts")],
      activeId: docId("C:\\proj", "src/velho/a.ts"),
    });

    await useEditor.getState().renameEntry("src/velho", "src/novo");

    expect(useEditor.getState().docs.map((d) => d.path)).toEqual([
      "src/novo/a.ts",
      "outro.ts",
    ]);
    expect(useEditor.getState().activeId).toBe(docId("C:\\proj", "src/novo/a.ts"));
  });

  /**
   * The backend only refuses a rename whose destination exists **on disk**,
   * so `a.ts -> b.ts` goes through while a tab for a deleted `b.ts` is still
   * open. Two documents with the same id are two identical React keys and
   * two tabs the bar cannot tell apart.
   */
  it("renaming over a ghost tab does not leave two documents with the same id", async () => {
    fsRenameEntry.mockResolvedValue(undefined);
    useEditor.setState({
      docs: [
        doc("a.ts", { text: "conteudo de a" }),
        // Open, but the file vanished from disk.
        doc("b.ts", { text: "fantasma", missing: true }),
      ],
      activeId: docId("C:\\proj", "a.ts"),
    });

    await useEditor.getState().renameEntry("a.ts", "b.ts");

    const { docs } = useEditor.getState();
    expect(docs).toHaveLength(1);
    expect(new Set(docs.map((d) => d.id)).size).toBe(docs.length);
    // The survivor is the renamed one — the only one with a real file behind it.
    expect(docs[0].path).toBe("b.ts");
    expect(docs[0].text).toBe("conteudo de a");
    expect(useEditor.getState().activeId).toBe(docId("C:\\proj", "b.ts"));
  });

  it("renaming changes the subtree's address, leaves no copy under the old name", async () => {
    fsRenameEntry.mockResolvedValue(undefined);
    const entry = (path: string, dir = false) => ({
      name: path.split("/").pop()!,
      path,
      dir,
      size: 0,
      modifiedAt: 0,
      symlink: false,
    });
    useEditor.setState({
      docs: [],
      dirs: {
        "": [entry("src", true)],
        src: [entry("src/velho", true)],
        "src/velho": [entry("src/velho/a.ts")],
      },
      expanded: { src: true, "src/velho": true },
    });
    // The rename ends by re-reading the parent directory from disk; that is
    // what has the final say.
    fsListDir.mockImplementationOnce(async (...args: unknown[]) => ({
      path: String(args[1] ?? ""),
      entries: [entry("src/novo", true)],
      dropped: 0,
    }));

    await useEditor.getState().renameEntry("src/velho", "src/novo");

    const { dirs, expanded } = useEditor.getState();
    // The old path must not survive: later re-creating a directory with that
    // name showed the ghost listing of the previous one.
    expect(dirs["src/velho"]).toBeUndefined();
    expect(expanded["src/velho"]).toBeUndefined();
    // And the new one carries the content, with the children already re-addressed.
    expect(dirs["src/novo"]?.map((e) => e.path)).toEqual(["src/novo/a.ts"]);
    expect(expanded["src/novo"]).toBe(true);
    // The parent directory starts listing the new name.
    expect(dirs["src"]?.map((e) => e.path)).toEqual(["src/novo"]);
    expect(dirs["src"]?.map((e) => e.name)).toEqual(["novo"]);
  });

  /**
   * The group/project leaves the workspace and its tabs have to leave with
   * it: a tab bound to a `groupId` that no longer resolves is drawn by no
   * pane, but keeps coming back from the kv at every boot and keeps being
   * counted in the close-the-window warning.
   */
  it("deleting a group takes its tabs; the others' stay", () => {
    useEditor.setState({
      docs: [
        doc("a.ts", { groupId: "g1" }),
        doc("b.ts", { groupId: "g2" }),
        doc("c.ts", { groupId: null }),
      ],
      activeId: docId("C:\\proj", "a.ts"),
      open: true,
    });

    useEditor.getState().dropScope({ groupId: "g1" });

    expect(useEditor.getState().docs.map((d) => d.path)).toEqual(["b.ts", "c.ts"]);
    expect(useEditor.getState().activeId).toBe(docId("C:\\proj", "b.ts"));
  });

  it("removing the project takes its tabs, on any floor", () => {
    useEditor.setState({
      docs: [
        doc("a.ts", { projectId: "p1", groupId: "g1" }),
        doc("b.ts", { projectId: "p1", groupId: "g2", root: "C:\\proj\\.yard\\floors\\x" }),
        doc("c.ts", { projectId: "p2", groupId: "g3" }),
      ],
    });

    useEditor.getState().dropScope({ projectId: "p1" });

    expect(useEditor.getState().docs.map((d) => d.path)).toEqual(["c.ts"]);
  });

  it("counts the drafts that would go along, so the confirmation can warn", () => {
    useEditor.setState({
      docs: [
        doc("a.ts", { groupId: "g1", text: "mexido" }),
        doc("b.ts", { groupId: "g1" }),
        doc("c.ts", { groupId: "g1", text: "mexido", truncated: true }),
        doc("d.ts", { groupId: "g2", text: "mexido" }),
      ],
    });

    const dirtyDocs = useEditor.getState().unsavedOf({ groupId: "g1" });
    // Only what has text to write and can be written — the truncated one is
    // read-only, so there is no draft to lose in it.
    expect(dirtyDocs.map((d) => d.path)).toEqual(["a.ts"]);
  });

  it("closing the active tab goes to the neighbour on the right", () => {
    useEditor.setState({
      docs: [doc("a.ts"), doc("b.ts"), doc("c.ts")],
      activeId: docId("C:\\proj", "b.ts"),
      open: true,
    });

    useEditor.getState().closeDoc(docId("C:\\proj", "b.ts"));

    expect(useEditor.getState().activeId).toBe(docId("C:\\proj", "c.ts"));
    expect(useEditor.getState().docs.map((d) => d.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("closing the last tab puts the editor away", () => {
    useEditor.setState({
      docs: [doc("a.ts")],
      activeId: docId("C:\\proj", "a.ts"),
      open: true,
    });
    useEditor.getState().closeDoc(docId("C:\\proj", "a.ts"));
    expect(useEditor.getState().open).toBe(false);
    expect(useEditor.getState().activeId).toBe(null);
  });

  it("keeps two files with the same relative path in different worktrees", async () => {
    fsReadText.mockResolvedValue({
      path: "src/App.tsx",
      text: "andar",
      binary: false,
      truncated: false,
      size: 5,
      modifiedAt: 2000,
      crlf: false,
    });
    useEditor.setState({ docs: [doc("src/App.tsx", { text: "chão", saved: "chão" })] });
    useEditor.getState().setRoot("p1", "C:\\proj\\.yard\\floor-a");

    await useEditor.getState().openFile("src/App.tsx");

    expect(useEditor.getState().docs).toHaveLength(2);
    expect(new Set(useEditor.getState().docs.map((d) => d.id)).size).toBe(2);
  });

  it("always saves to the document's root of origin", async () => {
    fsWriteText.mockResolvedValue({ modifiedAt: 5000, size: 8 });
    const previousValue = doc("src/App.tsx", { text: "rascunho" });
    useEditor.setState({ docs: [previousValue] });
    useEditor.getState().setRoot("p1", "C:\\proj\\.yard\\floor-a");

    await useEditor.getState().save(previousValue.id);

    expect(fsWriteText).toHaveBeenCalledWith(
      "C:\\proj",
      "src/App.tsx",
      "rascunho",
      { modifiedAt: 1000, size: 8 },
      false,
      false,
    );
  });

  it("reconciles a preserved tab when returning to its root", async () => {
    fsReadText.mockResolvedValue({
      path: "src/App.tsx",
      text: "mudou enquanto estava fora",
      binary: false,
      truncated: false,
      size: 24,
      modifiedAt: 3000,
      crlf: false,
    });
    useEditor.setState({
      root: "C:\\proj\\.yard\\floor-a",
      docs: [doc("src/App.tsx")],
    });

    useEditor.getState().setRoot("p1", "C:\\proj");

    await vi.waitFor(() => {
      expect(useEditor.getState().docs[0].text).toBe("mudou enquanto estava fora");
    });
    expect(useEditor.getState().docs[0].diskVersion).toBe(2);
  });
});

/**
 * F5, an HMR round and a webview reload never reach `onCloseRequested` — the
 * only thing between a refresh and lost typing is this record.
 */
describe("surviving a reload", () => {
  it("stores the draft of what is dirty and only the tab of what is clean", () => {
    const stored = parseStoredDocs(
      serializeDocs([
        doc("src/App.tsx", { text: "meio digitado", saved: "original" }),
        doc("src/limpo.ts"),
      ]),
    );
    expect(stored).toHaveLength(2);
    expect(stored[0].draft).toBe("meio digitado");
    // A buffer identical to disk is re-read from disk: storing it would be dead weight.
    expect(stored[1].draft).toBeUndefined();
  });

  it("does not store a draft of a read-only file", () => {
    const stored = parseStoredDocs(
      serializeDocs([doc("blob.bin", { text: "x", saved: "y", binary: true })]),
    );
    expect(stored[0].draft).toBeUndefined();
  });

  it("stores the disk stamp, which is what detects the conflict on return", () => {
    const stored = parseStoredDocs(
      serializeDocs([doc("a.ts", { text: "novo", saved: "velho", modifiedAt: 4242 })]),
    );
    expect(stored[0].modifiedAt).toBe(4242);
    expect(stored[0].root).toBe("C:\\proj");
    expect(stored[0].path).toBe("a.ts");
  });

  it("a corrupted kv does not bring the boot down", () => {
    expect(parseStoredDocs(undefined)).toEqual([]);
    expect(parseStoredDocs("{{{")).toEqual([]);
    expect(parseStoredDocs('{"nao":"array"}')).toEqual([]);
    expect(
      parseStoredDocs(JSON.stringify([{ semPath: true }, { root: "C:\\p", path: "ok.ts" }])),
    ).toHaveLength(1);
  });

  /**
   * Line wrapping was session state: whoever read a 400-column `.log` turned
   * on the bar's button and, at the next boot, found the file running off the
   * right edge again. It is a reading setting, like `mdMode` and the heading
   * rail beside it — it lasts.
   */
  it("the chosen line wrapping comes back at the next boot", async () => {
    readPrefs.mockResolvedValue({ "editor.wrap": "true" });
    useEditor.setState({ wrap: false });

    await useEditor.getState().restore();

    expect(useEditor.getState().wrap).toBe(true);
  });

  it("stores line wrapping in the kv when turning it on", async () => {
    vi.useFakeTimers();
    try {
      writePref.mockClear();
      useEditor.getState().setWrap(true);
      await vi.advanceTimersByTimeAsync(600);
      expect(writePref).toHaveBeenCalledWith("editor.wrap", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the tab with the draft on top of what is on disk", async () => {
    fsReadText.mockResolvedValue({
      path: "src/App.tsx",
      text: "o que está no disco",
      binary: false,
      truncated: false,
      size: 19,
      modifiedAt: 9000,
      crlf: false,
    });
    readPrefs.mockResolvedValue({
      "editor.docs": JSON.stringify([
        {
          projectId: "p1",
          root: "C:\\proj",
          path: "src/App.tsx",
          modifiedAt: 1000,
          crlf: false,
          draft: "o que eu tinha digitado",
        },
      ]),
      "editor.active": docId("C:\\proj", "src/App.tsx"),
      "editor.open": "true",
    });
    useEditor.setState({ docs: [], activeId: null, open: false });

    await useEditor.getState().restore();

    const [d] = useEditor.getState().docs;
    expect(d.text).toBe("o que eu tinha digitado");
    expect(d.saved).toBe("o que está no disco");
    expect(isDirty(d)).toBe(true);
    // Disk moved on while the app was away: this is the conflict the banner
    // already knows how to explain, not a silent overwrite.
    expect(d.stale).toBe(true);
    expect(useEditor.getState().open).toBe(true);
  });

  it("a clean tab whose file vanished from disk does not come back", async () => {
    fsReadText.mockRejectedValue(new Error("não existe"));
    readPrefs.mockResolvedValue({
      "editor.docs": JSON.stringify([
        { projectId: "p1", root: "C:\\proj", path: "foi.ts", modifiedAt: 1, crlf: false },
      ]),
    });
    useEditor.setState({ docs: [], activeId: null, open: false });

    await useEditor.getState().restore();

    expect(useEditor.getState().docs).toEqual([]);
  });

  it("a tab with a draft comes back even if the file vanished — the text only exists here", async () => {
    fsReadText.mockRejectedValue(new Error("não existe"));
    readPrefs.mockResolvedValue({
      "editor.docs": JSON.stringify([
        {
          projectId: "p1",
          root: "C:\\proj",
          path: "foi.ts",
          modifiedAt: 1,
          crlf: false,
          draft: "não perca isto",
        },
      ]),
    });
    useEditor.setState({ docs: [], activeId: null, open: false });

    await useEditor.getState().restore();

    const [d] = useEditor.getState().docs;
    expect(d.text).toBe("não perca isto");
    expect(d.missing).toBe(true);
  });
});
