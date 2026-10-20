/** Cancelling the native save dialog must leave both the transcript and filesystem untouched. */
import { afterEach, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ save: vi.fn(), fsWriteText: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: boundary.save }));
vi.mock("./ipc", () => ({ ipc: boundary }));
import { exportChatTopic } from "./chatExport";
import { beginTurn, createChat } from "./chat";

afterEach(() => vi.clearAllMocks());

it("exports through the native relative-path boundary instead of passing an absolute project path", async () => {
  const destination = "C:/exports/conversation.json";
  const files = new Map<string, string>();
  boundary.save.mockResolvedValueOnce(destination);
  boundary.fsWriteText.mockImplementationOnce(async (root: string, path: string, text: string) => {
    if (/^[A-Za-z]:|^[\\/]/.test(path)) throw new Error("Path outside the project root");
    files.set(root + path, text);
  });
  const document = beginTurn(createChat(), "turn-1", "Review", 1000);
  await expect(exportChatTopic(document, "terminal-1", 0, "Topic", new Date(1000))).resolves.toBe(true);
  expect(JSON.parse(files.get(destination)!).topic.messages[0].text).toBe("Review");
});

it("cancels export without writing a file or changing the pending chat request", async () => {
  const document = beginTurn(createChat(), "turn-1", "Original request", 1000);
  boundary.save.mockResolvedValueOnce(null);
  expect(await exportChatTopic(document, "terminal-1", 0, "Topic name", new Date(1000))).toBe(false);
  expect(boundary.fsWriteText).not.toHaveBeenCalled();
  expect(document.pending).toEqual({ id: "turn-1", thread: 0 });
  expect(document.threads[0].messages[0].text).toBe("Original request");
});

it("writes only the selected topic to the destination chosen in the native save dialog", async () => {
  const document = beginTurn(createChat(), "turn-1", "Original request", 1000);
  document.threads[1].draft = "Other topic stays private";
  const dest = "C:\\exports\\conversation.JSON";
  const files: Record<string, string> = {};
  boundary.save.mockResolvedValueOnce(dest);
  boundary.fsWriteText.mockImplementationOnce(async (root: string, path: string, text: string) => {
    expect(root).toBe("C:\\exports\\");
    files[root + path] = text;
  });
  expect(await exportChatTopic(document, "terminal-1", 0, "Topic name", new Date(1000))).toBe(true);
  expect(JSON.parse(files[dest]).topic.messages).toEqual(document.threads[0].messages);
  expect(files[dest]).not.toContain("Other topic stays private");
  expect(document.pending).toEqual({ id: "turn-1", thread: 0 });
});

it("writes readable Markdown when the selected destination has an md extension", async () => {
  const document = beginTurn(createChat(), "turn-1", "Review **this** file", 1000);
  const files: Record<string, string> = {};
  const dest = "C:/exports.json/conversation.md";
  boundary.save.mockResolvedValueOnce(dest);
  boundary.fsWriteText.mockImplementationOnce(async (root: string, path: string, text: string) => { files[root + path] = text; });
  expect(await exportChatTopic(document, "terminal-1", 0, "API review", new Date(1000))).toBe(true);
  expect(files[dest]).toContain("# API review");
  expect(files[dest]).toContain("Review **this** file");
});
