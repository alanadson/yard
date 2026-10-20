/**
 * The frontend delegates prompt framing and submission to one native operation.
 *
 * Two things are worth pinning down here. The bracketed paste, because without
 * it a ten-line prompt becomes ten submits in the agent's CLI. And the
 * `submit: false` case, because that is the whole promise the prompt window
 * makes: the text lands on the command line and the Enter stays with the user.
 * A stray `\r` there would send an unfinished prompt to an agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { injectPrompt } from "./inject";
import { useUI } from "../stores/uiStore";

const writePty = vi.fn(async () => {});
const checkpointCreate = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock("./ipc", () => ({
  ipc: {
    checkpointCreate: (...args: unknown[]) => checkpointCreate(...args),
    writePty: (...args: unknown[]) => writePty(...(args as [])),
  },
}));

/** Native requests, including the explicit submission mode. */
const written = () => [...writePty.mock.calls];

beforeEach(() => {
  useUI.setState({ toasts: [], toastHistory: [] });
  writePty.mockClear();
  checkpointCreate.mockReset();
});

describe("injectPrompt", () => {
  it("hands submission to one native operation and waits for its acknowledgement", async () => {
    let finish!: () => void;
    writePty.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    let complete = false;
    const sending = injectPrompt("t1", "Request owned by native delivery").then(() => { complete = true; });
    expect(writePty.mock.calls).toEqual([["t1", "Request owned by native delivery", true]]);
    expect(complete).toBe(false);
    finish();
    await sending;
    expect(writePty.mock.calls).toHaveLength(1);
    expect(complete).toBe(true);
  });
  it("saves the task checkpoint before any prompt reaches the terminal", async () => {
    let finish: (() => void) | undefined;
    checkpointCreate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const sending = injectPrompt("t1", "Fix login", { checkpoint: { root: "C:/repo", taskId: "task", taskLabel: "Login" } });
    await Promise.resolve();
    const beforeCheckpoint = written();
    finish?.();
    await sending;
    expect(beforeCheckpoint).toEqual([]);
    expect(checkpointCreate.mock.calls[0]).toEqual(["C:/repo", "task", "Login", "Fix login"]);
    expect(written()).toEqual([["t1", "Fix login", true]]);
  });
  it("requests native submission of a single-line prompt", async () => {
    await injectPrompt("t1", "oi");
    expect(written()).toEqual([["t1", "oi", true]]);
  });

  it("passes the complete multiline text to native paste framing", async () => {
    await injectPrompt("t1", "linha 1\nlinha 2");
    expect(written()).toEqual([["t1", "linha 1\nlinha 2", true]]);
  });

  it("with submit: false does not press Enter", async () => {
    await injectPrompt("t1", "prompt longo\nem duas linhas", { submit: false });
    expect(written()).toEqual([["t1", "prompt longo\nem duas linhas", false]]);
  });

  it("in raw mode writes only once, with no bonus Enter", async () => {
    await injectPrompt("t1", "\\x03", { raw: true });
    expect(written()).toEqual([["t1", "\x03"]]);
  });
});

describe("injectPrompt with a checkpoint that cannot be saved", () => {
  it("shows the missing recovery copy while preserving delivery of the original prompt", async () => {
    checkpointCreate.mockRejectedValueOnce(new Error("Disk full"));
    await injectPrompt("t1", "Fix login", { checkpoint: { root: "C:/repo", taskId: "task", taskLabel: "Login" } });
    expect(useUI.getState().toasts[0]?.message).toContain("sem checkpoint");
    expect(written()).toEqual([["t1", "Fix login", true]]);
  });
  /**
   * The regression this locks down: a repo over the snapshot limits made
   * `checkpointCreate` reject, and the prompt never reached the PTY, with
   * nothing on screen to say why.
   */
  it("still writes the prompt and the Enter when the checkpoint rejects", async () => {
    checkpointCreate.mockRejectedValueOnce(new Error("Disk full"));
    await injectPrompt("t1", "Fix login", { checkpoint: { root: "C:/repo", taskId: "task", taskLabel: "Login" } });
    expect(written()).toEqual([["t1", "Fix login", true]]);
  });
});
