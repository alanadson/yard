/** A task becomes visible only after native persistence acknowledges the work request. */
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ taskCreate: vi.fn(), taskList: vi.fn() }));
vi.mock("../lib/ipc", () => ({ ipc: native }));

import { useWork } from "./workStore";

afterEach(() => { useWork.setState({ tasks: [], selectedId: null, next: null, total: 0, loading: false, filter: "all", attentionTotal: 0 }); vi.clearAllMocks(); });

describe("durable work panel", () => {
  it("does not count a newly created task twice when polling sees it before the creation acknowledgement", async () => {
    const task = { id: "created", title: "New task", request: "request", status: "draft", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 1, createdAt: 1000, updatedAt: 1000 };
    let acknowledge!: (value: typeof task) => void;
    native.taskCreate.mockReturnValueOnce(new Promise((resolve) => { acknowledge = resolve; }));
    const pending = useWork.getState().create({ id: task.id, title: task.title, request: task.request, criteria: [], links: task.links });
    await Promise.resolve();
    useWork.setState({ tasks: [task], total: 1, selectedId: task.id });
    acknowledge(task);
    await pending;
    expect(useWork.getState().total).toBe(1);
    expect(useWork.getState().tasks).toEqual([task]);
  });
  it("creating a draft from attention returns to the complete task list", async () => {
    const blocked = { id: "blocked", title: "Blocked", request: "request", status: "blocked", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 1, createdAt: 1000, updatedAt: 1000 };
    const oldDraft = { ...blocked, id: "old-draft", status: "draft" };
    const created = { ...oldDraft, id: "created", title: "New work" };
    useWork.setState({ filter: "attention", tasks: [blocked], selectedId: blocked.id, total: 1, attentionTotal: 1 });
    native.taskList.mockResolvedValueOnce({ tasks: [blocked, oldDraft], total: 2, attentionTotal: 1, next: null });
    native.taskCreate.mockResolvedValueOnce(created);
    await useWork.getState().create({ id: created.id, title: created.title, request: created.request, criteria: [], links: created.links });
    expect(useWork.getState().filter).toBe("all");
    expect(useWork.getState().tasks).toEqual([created, blocked, oldDraft]);
    expect(useWork.getState().selectedId).toBe(created.id);
    expect(useWork.getState().total).toBe(3);
  });
  it("refreshes already loaded attention pages without bringing approved work back from a stale cache", async () => {
    const row = { title: "Needs review", request: "request", status: "in_review", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 3, createdAt: 1000, updatedAt: 2000 };
    const first = Array.from({ length: 200 }, (_, n) => ({ ...row, id: `review-${n}` }));
    const older = { ...row, id: "older-review", updatedAt: 1000 };
    const approved = { ...older, id: "approved-review" };
    useWork.setState({ filter: "attention", tasks: [...first, older, approved], selectedId: older.id, total: 202, attentionTotal: 202 });
    native.taskList.mockResolvedValueOnce({ tasks: first, next: { at: 2000, id: first.at(-1)!.id }, total: 201, attentionTotal: 201 });
    native.taskList.mockResolvedValueOnce({ tasks: [older], next: null, total: 201, attentionTotal: 201 });
    await useWork.getState().refresh();
    expect(useWork.getState().tasks).toEqual([...first, older]);
    expect(useWork.getState().selectedId).toBe(older.id);
    expect(useWork.getState().attentionTotal).toBe(201);
    expect(useWork.getState().next).toBeNull();
  });
  it("an approved task disappears from attention after the next acknowledged refresh", async () => {
    const reviewed = { id: "reviewed", title: "Reviewed work", request: "request", status: "in_review", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 3, createdAt: 1000, updatedAt: 2000 };
    useWork.setState({ filter: "attention", tasks: [reviewed], selectedId: reviewed.id, total: 1, attentionTotal: 1 });
    native.taskList.mockResolvedValueOnce({ tasks: [], total: 0, next: null, attentionTotal: 0 });
    await useWork.getState().refresh();
    expect(useWork.getState().tasks).toEqual([]);
    expect(useWork.getState().selectedId).toBeNull();
    expect(useWork.getState().total).toBe(0);
  });
  it("switching to attention replaces unrelated pages and ignores an older all-task refresh", async () => {
    const draft = { id: "draft", title: "Draft", request: "request", status: "draft", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 1, createdAt: 1000, updatedAt: 1000 };
    const blocked = { ...draft, id: "blocked", status: "blocked", title: "Interrupted work" };
    useWork.setState({ tasks: [draft], selectedId: draft.id, total: 201, next: { at: 1000, id: draft.id } });
    let older!: (page: unknown) => void;
    native.taskList.mockReturnValueOnce(new Promise((resolve) => { older = resolve; }));
    const pending = useWork.getState().refresh();
    native.taskList.mockResolvedValueOnce({ tasks: [blocked], total: 1, next: null, attentionTotal: 1 });
    await useWork.getState().setFilter("attention");
    older({ tasks: [draft], total: 201, next: { at: 1000, id: draft.id }, attentionTotal: 1 });
    await pending;
    expect(useWork.getState().tasks).toEqual([blocked]);
    expect(useWork.getState().selectedId).toBe(blocked.id);
    expect(useWork.getState().total).toBe(1);
    expect(useWork.getState().attentionTotal).toBe(1);
    expect(useWork.getState().next).toBeNull();
  });
  it("loading the next task page preserves the selected task and earlier results", async () => {
    const first = { id: "task-1", title: "First", request: "request", status: "draft", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 1, createdAt: 1_000, updatedAt: 1_000 };
    const second = { ...first, id: "task-2", title: "Second" };
    native.taskList.mockResolvedValueOnce({ tasks: [first], next: { at: 1_000, id: first.id }, total: 2 });
    native.taskList.mockResolvedValueOnce({ tasks: [second], next: null, total: 2 });
    await useWork.getState().refresh();
    await useWork.getState().loadMore();
    expect(useWork.getState().tasks).toEqual([first, second]);
    expect(useWork.getState().selectedId).toBe(first.id);
    expect(useWork.getState().next).toBeNull();
  });
  it("a slower earlier refresh cannot replace the latest task list", async () => {
    const task = { id: "task-1", title: "Latest work", request: "request", status: "draft", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 2, createdAt: 1_000, updatedAt: 2_000 };
    const latest = { tasks: [task], next: null, total: 1 };
    let older!: (page: typeof latest) => void;
    let newer!: (page: typeof latest) => void;
    native.taskList.mockReturnValueOnce(new Promise<typeof latest>((resolve) => { older = resolve; }));
    native.taskList.mockReturnValueOnce(new Promise<typeof latest>((resolve) => { newer = resolve; }));
    const first = useWork.getState().refresh();
    const second = useWork.getState().refresh();
    newer(latest);
    await second;
    older({ ...latest, tasks: [{ ...task, revision: 1, title: "Outdated work" }] });
    await first;
    expect(useWork.getState().tasks).toEqual([task]);
  });
  it("shows a created task only after native persistence acknowledges it", async () => {
    const task = { id: "task-1", title: "Verify API", request: "Check the response contract", status: "draft", criteria: [], links: { projectId: null, terminalIds: [] }, delivery: null, revision: 1, createdAt: 1_000, updatedAt: 1_000 };
    let acknowledge!: (row: typeof task) => void;
    native.taskCreate.mockReturnValue(new Promise<typeof task>((resolve) => { acknowledge = resolve; }));
    const creation = useWork.getState().create({ id: task.id, title: task.title, request: task.request, criteria: [], links: task.links });
    expect(useWork.getState().tasks).toEqual([]);
    acknowledge(task);
    await creation;
    expect(useWork.getState().tasks).toEqual([task]);
    expect(useWork.getState().selectedId).toBe(task.id);
  });
});
