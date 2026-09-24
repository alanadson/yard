/**
 * What a mounting terminal asks `attach_pty` for, and what it does with the
 * answer. The two halves have to agree: the view only learns whether the
 * process is alive from the answer, so it states its uses as conditions, and
 * the backend drops whatever those conditions say will not be read. Ask for
 * too little and a pane opens without the history it would have shown; ask
 * for too much and every restart reads, encodes and ships megabytes of
 * scrollback that nobody paints.
 */
import { describe, expect, it } from "vitest";
import type { AttachResult, AttachWants } from "../../lib/ipc";
import { SCAN_TAIL, attachWants, replayPlan } from "./attachPlan";

type Answer = Pick<AttachResult, "alive" | "altScreen" | "data">;

/** A history longer than the scanned tail, with an emoji across its cut. */
const LONG = "\x1b[1;32mverde\x1b[0m ação\r\n".repeat(5000) + "😀".repeat(40) + " fim\r\n";

describe("attachWants", () => {
  it("asks to leave a dead history behind when the view will start a new process on a clean screen", () => {
    expect(attachWants(true).omitDeadHistory).toBe(true);
  });

  it("asks for the dead history when the terminal waits for Retomar, which replays it", () => {
    expect(attachWants(false).omitDeadHistory).toBe(false);
  });

  it("asks, for a live alternate screen, for exactly the tail the scanners read", () => {
    expect(attachWants(true).altTail).toBe(SCAN_TAIL);
    expect(attachWants(false).altTail).toBe(SCAN_TAIL);
  });
});

describe("replayPlan", () => {
  it("rebuilds a live ordinary screen from its history and scans the tail", () => {
    const plan = replayPlan({ alive: true, altScreen: false, data: LONG }, true);
    expect(plan).toEqual({
      freshBoot: false,
      askForFrame: false,
      rebuild: LONG,
      scanTail: LONG.slice(-SCAN_TAIL),
    });
  });

  it("asks a live full-screen CLI for its frame, entering the alternate screen, and still scans the tail", () => {
    const plan = replayPlan({ alive: true, altScreen: true, data: LONG }, false);
    expect(plan).toEqual({
      freshBoot: false,
      askForFrame: true,
      rebuild: "\x1b[?1049h",
      scanTail: LONG.slice(-SCAN_TAIL),
    });
  });

  it("starts a dead terminal with auto-start on a clean screen: nothing replayed, nothing scanned", () => {
    const plan = replayPlan({ alive: false, altScreen: false, data: LONG }, true);
    expect(plan).toEqual({ freshBoot: true, askForFrame: false, rebuild: "", scanTail: null });
  });

  it("replays a dead terminal waiting for Retomar, without scanning a process that is gone", () => {
    const plan = replayPlan({ alive: false, altScreen: false, data: LONG }, false);
    expect(plan).toEqual({ freshBoot: false, askForFrame: false, rebuild: LONG, scanTail: null });
  });

  it("scans nothing when a live terminal has no history yet", () => {
    const plan = replayPlan({ alive: true, altScreen: false, data: "" }, true);
    expect(plan).toEqual({ freshBoot: false, askForFrame: false, rebuild: "", scanTail: null });
  });
});

/**
 * The backend's side of the contract (`pty::history_cut` and
 * `Scrollback::tail_utf16`): a dead history the view discards comes back
 * empty, and a live alternate screen sends a suffix that holds at least the
 * last `altTail` UTF-16 units. `extra` models how much longer than that the
 * suffix may be (it cuts at a byte boundary).
 */
function answerAsAsked(whole: Answer, wants: AttachWants, extra: number): Answer {
  if (!whole.alive && wants.omitDeadHistory) return { ...whole, data: "" };
  if (whole.alive && whole.altScreen && wants.altTail) {
    return { ...whole, data: whole.data.slice(-(wants.altTail + extra)) };
  }
  return whole;
}

describe("the answer to what was asked", () => {
  it("drives the view exactly as the whole history did, in every state", () => {
    for (const autoStart of [true, false]) {
      for (const [alive, altScreen] of [
        [false, false],
        [true, false],
        [true, true],
      ] as const) {
        const whole: Answer = { alive, altScreen, data: LONG };
        for (const extra of [0, 1, 3, 500]) {
          const cut = answerAsAsked(whole, attachWants(autoStart), extra);
          expect(replayPlan(cut, autoStart), `${autoStart} ${alive} ${altScreen} +${extra}`).toEqual(
            replayPlan(whole, autoStart),
          );
        }
      }
    }
  });
});
