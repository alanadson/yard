/**
 * The balloon is a fixed element in `<body>`, above every panel. Above every
 * *DOM* panel: a portal's page is an OS window parented to the main one, and
 * no z-index reaches it. The browser pane's toolbar hints opened their balloon
 * straight into the page below the toolbar, and the page painted over all but
 * a sliver of it. What the app does for a menu applies here: the balloon
 * publishes where it is (`occludersStore`) and the portals under it cut a
 * hole. This file drives the real wiring with a DOM small enough to fit in a
 * test, so the publish/retire pair is pinned to the open/close pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TIP_DELAY } from "./tip";
import { startTipLayer } from "./tipLayer";
import { useOccluders } from "../stores/occludersStore";

class FakeNode {
  parent: FakeNode | null = null;
  children: FakeNode[] = [];
  appendChild(n: FakeNode): FakeNode {
    n.parent = this;
    this.children.push(n);
    return n;
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  contains(n: FakeNode | null): boolean {
    for (let c: FakeNode | null = n; c; c = c.parent) if (c === this) return true;
    return false;
  }
  get isConnected(): boolean {
    let c: FakeNode = this;
    while (c.parent) c = c.parent;
    return c === doc;
  }
}

class FakeElement extends FakeNode {
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = {
    toggle: (c: string, on: boolean) => void (on ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  hidden = false;
  textContent = "";
  className = "";
  rect = { left: 0, top: 0, width: 0, height: 0 };
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getBoundingClientRect() {
    const r = this.rect;
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  }
  closest(selector: string): FakeElement | null {
    if (selector !== "[data-tip]") throw new Error(`unexpected selector ${selector}`);
    for (let c: FakeNode | null = this; c; c = c.parent) {
      if (c instanceof FakeElement && c.attrs.has("data-tip")) return c;
    }
    return null;
  }
  matches(): boolean {
    return false;
  }
}

type Listener = (e: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const doc = Object.assign(new FakeNode(), {
  body: new FakeElement(),
  createElement: () => new FakeElement(),
  addEventListener: (type: string, fn: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
});
doc.appendChild(doc.body);
const fire = (type: string, event: unknown) => {
  for (const fn of listeners.get(type) ?? []) fn(event);
};

/** A control with a hint, sitting in the body at (100, 20), 20 by 20. */
function control(tip: string): FakeElement {
  const el = new FakeElement();
  el.setAttribute("data-tip", tip);
  el.rect = { left: 100, top: 20, width: 20, height: 20 };
  doc.body.appendChild(el);
  return el;
}

/** Hover `el` and wait the delay out; returns the balloon. */
function open(el: FakeElement): FakeElement {
  fire("pointerover", { target: el, buttons: 0 });
  vi.advanceTimersByTime(TIP_DELAY);
  return doc.body.children.find((c) => (c as FakeElement).className === "tip-layer") as FakeElement;
}

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("Element", FakeElement);
  useOccluders.setState({ rects: {} });
  doc.body.children = [];
  listeners.clear();
  stop = startTipLayer();
  // The balloon measures 100 by 30 whatever it says.
  const layer = doc.body.children[0] as FakeElement;
  layer.rect = { left: 0, top: 0, width: 100, height: 30 };
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the balloon over a portal", () => {
  it("open, it publishes its rectangle so the portal under it cuts a hole", () => {
    const layer = open(control("Recarregar"));
    expect(layer.hidden).toBe(false);
    expect(layer.textContent).toBe("Recarregar");
    // Centred below the control: x = 110 - 50, y = 40.
    expect(layer.style.left).toBe("60px");
    expect(layer.style.top).toBe("40px");
    expect(useOccluders.getState().rects.tip).toEqual({ x: 60, y: 40, w: 100, h: 30 });
  });

  it("closed, the hole goes with it", () => {
    const layer = open(control("Recarregar"));
    fire("pointerover", { target: new FakeElement(), buttons: 0 });
    expect(layer.hidden).toBe(true);
    expect(useOccluders.getState().rects.tip).toBeUndefined();
  });

  it("stopping the layer takes the balloon and the hole out together", () => {
    const layer = open(control("Recarregar"));
    stop();
    expect(layer.parent).toBeNull();
    expect(useOccluders.getState().rects.tip).toBeUndefined();
    stop = () => {};
  });
});
