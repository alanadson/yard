/** Device automation must resolve the same connected portal as browser automation. */
import { beforeEach, expect, it, vi } from "vitest";
import type { DeviceAction } from "./devicePortal";
const boundary = vi.hoisted(() => ({
  deviceAction: vi.fn(
    async (_serial: string, _action: DeviceAction) => "png-base64",
  ),
  deviceList: vi.fn(async () => [
    { serial: "phone-1", name: "Phone", state: "device" },
  ]),
  clipboardSaveImage: vi.fn(async () => "C:/Temp/android.png"),
  portalInfo: vi.fn(async () => ({})),
  portalOpen: vi.fn(async () => {
    throw new Error("Browser engine unavailable");
  }),
  portalEval: vi.fn(async () => "browser action"),
  portalScreenshot: vi.fn(async () => "C:/Temp/browser.png"),
  readPrefs: vi.fn(async () => ({})),
}));
vi.mock("./ipc", () => ({ ipc: boundary }));
import { cmdPortal } from "./bridgePortal";
import { makeCtx } from "./bridgeCore";
import { EMPTY_CANVAS, type CanvasData } from "./canvas";
import type { TerminalRow } from "./ipc";
import { useProjects } from "../stores/projectsStore";
import { openPortalEngine } from "./portalSpawn";

const caller: TerminalRow = {
  id: "agent",
  groupId: "board",
  slot: 0,
  title: "Agent",
  kind: "agent",
  agentId: "codex",
  program: "codex",
  args: [],
  cwd: "C:/repo",
  resume: null,
  sort: 0,
  alive: true,
  createdAt: 1,
};
const canvas: CanvasData = {
  ...EMPTY_CANVAS,
  items: [
    {
      id: "phone",
      type: "portal",
      deviceSerial: "phone-1",
      url: "about:blank",
      name: "Phone",
      x: 0,
      y: 0,
      w: 360,
      h: 700,
      color: "#fff",
    },
    {
      id: "wire",
      type: "connection",
      from: "agent",
      to: "phone",
      color: "#fff",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  boundary.deviceAction.mockResolvedValue("png-base64");
});

it("rejects browser-only edits on a connected Android portal", async () => {
  vi.stubGlobal("window", { dispatchEvent: () => true });
  const response = await cmdPortal(makeCtx(caller, "board", canvas, [caller]), [
    "edit",
    "Phone",
    "--live",
    "on",
  ]);
  expect(response.code).toBe(1);
  expect(response.output).toContain("navigate");
});

it("restores a device portal without trying to start a webview", async () => {
  await expect(
    openPortalEngine({
      id: "phone",
      url: "about:blank",
      deviceSerial: "phone-1",
      x: 0,
      y: 0,
      w: 360,
      h: 700,
    }),
  ).resolves.toBeUndefined();
});

it("lists Android targets with their authorization state", async () => {
  const result = await cmdPortal(makeCtx(caller, "board", canvas, [caller]), [
    "devices",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.output)).toEqual([
    { serial: "phone-1", name: "Phone", state: "device" },
  ]);
});

it("creates and connects an Android portal from the CLI", async () => {
  vi.stubGlobal("window", { dispatchEvent: () => true });
  useProjects.setState({
    groups: [
      {
        id: "board",
        projectId: null,
        name: "Board",
        sort: 0,
        layoutJson: JSON.stringify({ canvas }),
        suspended: false,
      },
    ],
    terminals: [caller],
  });
  const response = await cmdPortal(makeCtx(caller, "board", canvas, [caller]), [
    "create",
    "--device",
    "phone-1",
    "Test phone",
  ]);
  expect(response.code).toBe(0);
  const fresh = useProjects.getState().layoutOf("board").canvas!;
  const created = fresh.items.find(
    (item) => item.type === "portal" && item.name === "Test phone",
  );
  expect(created).toMatchObject({
    deviceSerial: "phone-1",
    url: "about:blank",
  });
  expect(
    fresh.items.some(
      (item) =>
        item.type === "connection" &&
        item.from === caller.id &&
        item.to === created?.id,
    ),
  ).toBe(true);
});

it("routes connected device gestures and navigation through the Android transport", async () => {
  boundary.deviceAction.mockImplementation(async (serial, action) =>
    JSON.stringify({ serial, action }),
  );
  const cases: [string[], DeviceAction][] = [
    [["click", "12,34"], { kind: "tap", x: 12, y: 34 }],
    [
      ["swipe", "1,2", "30,40", "250"],
      { kind: "swipe", x: 1, y: 2, toX: 30, toY: 40, duration: 250 },
    ],
    [["type", "hello world"], { kind: "text", text: "hello world" }],
    [["key", "back"], { kind: "key", key: "back" }],
    [
      ["navigate", "https://example.com"],
      { kind: "openUrl", url: "https://example.com" },
    ],
    [
      ["launch", "com.example.app"],
      { kind: "launch", package: "com.example.app" },
    ],
    [["stop", "com.example.app"], { kind: "stop", package: "com.example.app" }],
    [["snapshot"], { kind: "snapshot" }],
  ];
  for (const [[verb, ...args], action] of cases) {
    const response = await cmdPortal(
      makeCtx(caller, "board", canvas, [caller]),
      [verb, "Phone", ...args],
    );
    expect(response).toEqual({
      code: 0,
      output: JSON.stringify({ serial: "phone-1", action }) + "\n",
    });
  }
});

it("captures the connected Android screen instead of opening a browser", async () => {
  const response = await cmdPortal(makeCtx(caller, "board", canvas, [caller]), [
    "screenshot",
    "Phone",
  ]);
  expect(response).toEqual({ code: 0, output: "C:/Temp/android.png\n" });
});
