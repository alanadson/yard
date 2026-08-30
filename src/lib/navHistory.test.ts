/**
 * Going back.
 *
 * The editor already knew how to teleport: `Ctrl+P`, `F12`, a hit in the
 * project search, a `Ctrl+click` on a path the build printed. None of them
 * left a way home, so reading a stack trace three files deep ended with the
 * reader trying to remember which file they had started in.
 *
 * The model is the browser's, because that is the one every person already
 * has in their hands: a trail behind, a trail ahead, and a new jump from the
 * middle of the trail throws the part ahead away. What counts as a jump is
 * the only judgement call here, walking down a function with the arrow keys
 * is not travel, and recording it would make "back" mean "one line up".
 */
import { describe, expect, it } from "vitest";

import {
  arrive,
  dropDoc,
  forgetDoc,
  goBack,
  goForward,
  isJump,
  NAV_CAP,
  NO_HISTORY,
  NO_NAV,
  record,
  stepBack,
  stepForward,
  type NavHistory,
} from "./navHistory";

const at = (id: string, line: number) => ({ id, line });

describe("isJump", () => {
  it("counts opening another file", () => {
    expect(isJump(at("a", 10), at("b", 10))).toBe(true);
  });

  it("does not count walking a few lines inside the same file", () => {
    // Arrow keys, Enter, a click one paragraph down: this is reading, not
    // travelling, and recording it would make Alt+← mean "one line up".
    expect(isJump(at("a", 10), at("a", 14))).toBe(false);
  });

  it("counts a leap across the same file", () => {
    expect(isJump(at("a", 10), at("a", 400))).toBe(true);
    expect(isJump(at("a", 400), at("a", 10))).toBe(true);
  });

  it("has nothing to record when there was nowhere to come from", () => {
    expect(isJump(null, at("a", 10))).toBe(false);
  });
});

describe("record", () => {
  it("keeps the place that was left behind", () => {
    const h = record(NO_HISTORY, at("a", 10));

    expect(h.back).toEqual([at("a", 10)]);
  });

  it("throws away the trail ahead, a new jump is a new branch", () => {
    const walked = goBack(record(record(NO_HISTORY, at("a", 1)), at("b", 2)), at("c", 3))!;
    expect(walked.history.forward).toHaveLength(1);

    const branched = record(walked.history, at("d", 4));

    expect(branched.forward).toEqual([]);
  });

  it("does not stack the same place twice", () => {
    const h = record(record(NO_HISTORY, at("a", 10)), at("a", 10));

    expect(h.back).toEqual([at("a", 10)]);
  });

  it("drops the oldest place once the trail is full", () => {
    let h: NavHistory = NO_HISTORY;
    for (let i = 0; i < NAV_CAP + 5; i++) h = record(h, at("a", i * 100));

    expect(h.back).toHaveLength(NAV_CAP);
    expect(h.back[0]).toEqual(at("a", 5 * 100));
  });
});

describe("goBack and goForward", () => {
  it("has nowhere to go with an empty trail", () => {
    expect(goBack(NO_HISTORY, at("a", 1))).toBeNull();
    expect(goForward(NO_HISTORY, at("a", 1))).toBeNull();
  });

  it("returns the last place left and remembers where it was called from", () => {
    const h = record(NO_HISTORY, at("a", 10));

    const step = goBack(h, at("b", 99))!;

    expect(step.go).toEqual(at("a", 10));
    expect(step.history.back).toEqual([]);
    expect(step.history.forward).toEqual([at("b", 99)]);
  });

  it("walks the trail all the way there and all the way back", () => {
    // a → b → c, then twice back lands on a, then twice forward on c.
    let h = record(record(NO_HISTORY, at("a", 1)), at("b", 2));

    const first = goBack(h, at("c", 3))!;
    const second = goBack(first.history, first.go)!;
    expect(second.go).toEqual(at("a", 1));

    const ahead = goForward(second.history, second.go)!;
    const ahead2 = goForward(ahead.history, ahead.go)!;
    expect(ahead2.go).toEqual(at("c", 3));
    expect(goForward(ahead2.history, ahead2.go)).toBeNull();
  });
});

describe("dropDoc", () => {
  it("takes a closed file out of both trails", () => {
    // The regression: back used to land on a tab that no longer existed,
    // which reopened the file from disk and lost the reader's place anyway.
    const h: NavHistory = {
      back: [at("a", 1), at("b", 2), at("a", 3)],
      forward: [at("b", 4), at("c", 5)],
    };

    const left = dropDoc(h, "b");

    expect(left.back).toEqual([at("a", 1), at("a", 3)]);
    expect(left.forward).toEqual([at("c", 5)]);
  });
});


/**
 * The whole trail as one value, so the store that holds it has no judgement
 * of its own left to get wrong: it hands over where the caret landed and gets
 * back the new trail.
 */
describe("the trail as a whole", () => {
  it("records the place left behind, never the place arrived at", () => {
    // The defect this prevents: recording the destination makes Alt+left
    // return you to where you already are.
    const read = arrive(NO_NAV, at("a", 10));

    const jumped = arrive(read, at("b", 200));

    expect(jumped.history.back).toEqual([at("a", 10)]);
    expect(jumped.here).toEqual(at("b", 200));
  });

  it("does not record the first place, there was nowhere to come from", () => {
    const first = arrive(NO_NAV, at("a", 10));

    expect(first.history.back).toEqual([]);
    expect(first.here).toEqual(at("a", 10));
  });

  it("follows the caret without recording while the reader is just reading", () => {
    const read = arrive(arrive(NO_NAV, at("a", 10)), at("a", 12));

    expect(read.history.back).toEqual([]);
    expect(read.here).toEqual(at("a", 12));
  });

  it("goes back to where the last jump started", () => {
    const jumped = arrive(arrive(NO_NAV, at("a", 10)), at("b", 200));

    const step = stepBack(jumped)!;

    expect(step.go).toEqual(at("a", 10));
    expect(step.nav.here).toEqual(at("a", 10));
  });

  it("landing after a step back does not record a second time", () => {
    // The surface publishes the caret once the reveal lands. That arrival is
    // the step we just took, not a new one, or every back would leave a
    // matching forward and the trail would never shorten.
    const jumped = arrive(arrive(NO_NAV, at("a", 10)), at("b", 200));
    const step = stepBack(jumped)!;

    const landed = arrive(step.nav, at("a", 10));

    expect(landed.history.back).toEqual([]);
    expect(landed.history.forward).toEqual([at("b", 200)]);
  });

  it("goes forward again to where it came from", () => {
    const jumped = arrive(arrive(NO_NAV, at("a", 10)), at("b", 200));
    const back = stepBack(jumped)!;

    const ahead = stepForward(back.nav)!;

    expect(ahead.go).toEqual(at("b", 200));
    expect(stepForward(ahead.nav)).toBeNull();
  });

  it("has nowhere to step before the caret has landed anywhere", () => {
    expect(stepBack(NO_NAV)).toBeNull();
    expect(stepForward(NO_NAV)).toBeNull();
  });

  it("forgets a closed file, the current place included", () => {
    const jumped = arrive(arrive(NO_NAV, at("a", 10)), at("b", 200));

    const left = forgetDoc(jumped, "b");

    expect(left.history.back).toEqual([at("a", 10)]);
    expect(left.here).toBeNull();
  });

  it("keeps the current place when another file closes", () => {
    const jumped = arrive(arrive(NO_NAV, at("a", 10)), at("b", 200));

    const left = forgetDoc(jumped, "a");

    expect(left.history.back).toEqual([]);
    expect(left.here).toEqual(at("b", 200));
  });
});
