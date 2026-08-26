/**
 * Adding a project used to live inline in one dialog. The first-run sheet is
 * a second door into the same workspace, and two copies of "trim, dedupe,
 * check the folder, add" would drift — the trailing-space bug (a pasted path
 * stored untrimmed, so its root never matched again) was fixed in exactly
 * this logic once already.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { isDirectory } = vi.hoisted(() => ({
  isDirectory: vi.fn(async (_path: string) => true),
}));

vi.mock("./ipc", () => ({
  ipc: {
    isDirectory,
    saveWorkspace: vi.fn(async () => ({ accepted: true, rev: 2 })),
    loadWorkspace: vi.fn(),
    readPrefs: vi.fn(async () => ({}) as Record<string, string>),
    writePref: vi.fn(async () => undefined),
    listPtys: vi.fn(async () => []),
  },
}));

import { createProject, folderName, validateProjectPath } from "./projectCreate";
import { useProjects } from "../stores/projectsStore";

beforeEach(() => {
  isDirectory.mockClear();
  isDirectory.mockResolvedValue(true);
  useProjects.setState({
    projects: [],
    groups: [],
    terminals: [],
    activeProjectId: null,
    activeGroupId: null,
    loaded: false,
  });
});

describe("folderName", () => {
  it("is the last segment of the path, on either separator", () => {
    expect(folderName("C:\\Workspace\\meu-projeto\\")).toBe("meu-projeto");
    expect(folderName("/home/ana/api")).toBe("api");
    expect(folderName("C:\\")).toBe("C:");
  });
});

describe("validateProjectPath", () => {
  it("refuses an empty path", () => {
    expect(validateProjectPath("   ", [])).toEqual({ error: "Escolha uma pasta." });
  });

  it("trims the path — a trailing space must never reach the store", () => {
    expect(validateProjectPath("C:\\proj ", [])).toEqual({ path: "C:\\proj" });
  });

  it("names the project that already owns the folder, case and separator aside", () => {
    const existing = [{ name: "Loja", path: "c:/Proj" }];
    expect(validateProjectPath("C:\\proj", existing)).toEqual({
      error: "Essa pasta já está no workspace como “Loja”.",
    });
  });
});

describe("createProject", () => {
  it("adds the project with the folder's name when none is given and makes it active", async () => {
    const result = await createProject({ path: "C:\\Workspace\\loja" });
    expect(result.ok).toBe(true);
    const s = useProjects.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0].name).toBe("loja");
    expect(s.activeProjectId).toBe(s.projects[0].id);
    expect(s.groups.filter((g) => g.projectId === s.projects[0].id)).toHaveLength(1);
  });

  it("uses the typed name, trimmed, and passes the style along", async () => {
    await createProject({ path: "C:\\x", name: "  Minha API ", style: { icon: "🚀", color: "#f00" } });
    const p = useProjects.getState().projects[0];
    expect(p.name).toBe("Minha API");
    expect(p.icon).toBe("🚀");
    expect(p.color).toBe("#f00");
  });

  it("refuses a path that is not a folder, without touching the store", async () => {
    isDirectory.mockResolvedValue(false);
    const result = await createProject({ path: "C:\\nope" });
    expect(result).toEqual({ ok: false, error: "Esse caminho não existe ou não é uma pasta." });
    expect(useProjects.getState().projects).toHaveLength(0);
  });

  it("reports the duplicate the store catches in the window after the folder check", async () => {
    // Another door adds the same folder while `isDirectory` is in flight.
    isDirectory.mockImplementation(async () => {
      useProjects.getState().addProject("Outro", "C:\\race");
      return true;
    });
    const result = await createProject({ path: "C:\\race" });
    expect(result).toEqual({ ok: false, error: "Essa pasta já está no workspace." });
    expect(useProjects.getState().projects).toHaveLength(1);
  });
});
