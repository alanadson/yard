// Simultaneous notices share one permission request and retain each caller's delivery.
import { expect, it, vi } from "vitest";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { notify } from "./notifications";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));

it("shares permission checks for concurrent notices and checks again after completion", async () => {
  await Promise.all([
    notify({ title: "test", body: "one" }),
    notify({ title: "test", body: "two" }),
  ]);
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(sendNotification).toHaveBeenCalledWith({ title: "test", body: "one" });
  expect(sendNotification).toHaveBeenCalledWith({ title: "test", body: "two" });
  vi.mocked(isPermissionGranted).mockResolvedValueOnce(false);
  vi.mocked(requestPermission).mockResolvedValueOnce("denied");
  await notify({ title: "test", body: "denied" });
  expect(requestPermission).toHaveBeenCalledTimes(2);
  expect(sendNotification).toHaveBeenCalledTimes(2);
});
