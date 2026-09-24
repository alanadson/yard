/** Device gestures must use screen pixels, even when the canvas scales the card. */
import { expect, it } from "vitest";
import { deviceGesture, devicePoint, devicePortalItem } from "./devicePortal";

it("creates an Android portal only for an authorized online device", () => {
  const device = { serial: "emulator-5554", name: "Pixel 8", state: "device" };
  expect(devicePortalItem("phone", device, { x: 10, y: 20 })).toMatchObject({
    id: "phone",
    type: "portal",
    deviceSerial: "emulator-5554",
    name: "Pixel 8",
    x: 10,
    y: 20,
    url: "about:blank",
  });
  expect(() =>
    devicePortalItem(
      "phone",
      { ...device, state: "unauthorized" },
      { x: 0, y: 0 },
    ),
  ).toThrow();
});

it("distinguishes a tap from a swipe and bounds its duration", () => {
  expect(deviceGesture({ x: 10, y: 20 }, { x: 12, y: 21 }, 50)).toEqual({
    kind: "tap",
    x: 12,
    y: 21,
  });
  expect(deviceGesture({ x: 10, y: 20 }, { x: 100, y: 200 }, 9000)).toEqual({
    kind: "swipe",
    x: 10,
    y: 20,
    toX: 100,
    toY: 200,
    duration: 5000,
  });
});

it("maps a scaled device image to its native pixels and ignores the letterbox", () => {
  const box = { x: 100, y: 50, w: 400, h: 400 };
  expect(devicePoint({ x: 300, y: 250 }, box, { w: 100, h: 200 })).toEqual({
    x: 50,
    y: 100,
  });
  expect(devicePoint({ x: 110, y: 250 }, box, { w: 100, h: 200 })).toBeNull();
});
