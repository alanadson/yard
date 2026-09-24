import type { Box, CanvasItem } from "./canvas";

export interface AndroidDevice {
  serial: string;
  name: string;
  state: string;
}

export function devicePortalItem(
  id: string,
  device: AndroidDevice,
  at: { x: number; y: number },
  name?: string,
): Extract<CanvasItem, { type: "portal" }> {
  if (device.state !== "device")
    throw new Error("Android device is offline or unauthorized");
  return {
    id,
    type: "portal",
    ...at,
    w: 360,
    h: 700,
    url: "about:blank",
    color: "#f5f5f5",
    deviceSerial: device.serial,
    name: name?.trim() || device.name,
  };
}
export type DeviceAction =
  | { kind: "screenshot" | "snapshot" }
  | { kind: "tap"; x: number; y: number }
  | {
      kind: "swipe";
      x: number;
      y: number;
      toX: number;
      toY: number;
      duration: number;
    }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string }
  | { kind: "openUrl"; url: string }
  | { kind: "launch" | "stop"; package: string };

export function deviceGesture(
  from: { x: number; y: number },
  to: { x: number; y: number },
  elapsed: number,
): DeviceAction {
  return Math.hypot(to.x - from.x, to.y - from.y) < 8
    ? { kind: "tap", ...to }
    : {
        kind: "swipe",
        ...from,
        toX: to.x,
        toY: to.y,
        duration: Math.max(50, Math.min(5000, Math.round(elapsed))),
      };
}

export function deviceCommand(verb: string, args: string[]): DeviceAction {
  const point = (value: string | undefined) => {
    const match = value?.match(/^(\d+),(\d+)$/);
    if (!match || Number(match[1]) > 65535 || Number(match[2]) > 65535)
      throw new Error("Expected coordinates x,y between 0 and 65535");
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  switch (verb) {
    case "snapshot":
      return { kind: "snapshot" };
    case "click":
      return { kind: "tap", ...point(args[0]) };
    case "swipe": {
      const from = point(args[0]),
        to = point(args[1]);
      const duration = Number(args[2] ?? 300);
      if (!Number.isInteger(duration) || duration < 1 || duration > 5000)
        throw new Error("Expected a duration between 1 and 5000 ms");
      return { kind: "swipe", ...from, toX: to.x, toY: to.y, duration };
    }
    case "type":
      return { kind: "text", text: args.join(" ") };
    case "key":
      return { kind: "key", key: args[0] ?? "" };
    case "navigate":
      return { kind: "openUrl", url: args[0] ?? "" };
    case "launch":
    case "stop":
      return { kind: verb, package: args[0] ?? "" };
    default:
      throw new Error(
        "Android supports snapshot, screenshot, click x,y, swipe x,y x,y [ms], type, key, navigate, launch and stop",
      );
  }
}

export function devicePoint(
  point: { x: number; y: number },
  box: Box,
  screen: { w: number; h: number },
): { x: number; y: number } | null {
  if (screen.w <= 0 || screen.h <= 0 || box.w <= 0 || box.h <= 0) return null;
  const scale = Math.min(box.w / screen.w, box.h / screen.h);
  const x = (point.x - box.x - (box.w - screen.w * scale) / 2) / scale;
  const y = (point.y - box.y - (box.h - screen.h * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= screen.w || y >= screen.h) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}
