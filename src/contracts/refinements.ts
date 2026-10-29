/** Validate frontend-only refinements of the generated Rust wire types. */
import type * as Wire from "../desktop/bindings";
import type { PtySnapshot, UsageSnapshot } from "./types";
import type * as Model from "./types";
import type * as Work from "../lib/work";
import type * as Pricing from "../lib/pricing";
import type { CheckpointPreview } from "../lib/checkpoints";
import type { NativeQueueResult, QueueItem } from "../lib/queue";

export function member<const T extends readonly string[]>(
  value: string,
  allowed: T,
  field: string,
): T[number] {
  if (!allowed.includes(value)) throw new Error(`Invalid ${field}: ${value}`);
  return value as T[number];
}

export function terminal(value: Wire.PtySnapshot_Serialize): PtySnapshot {
  return {
    ...value,
    kind: member(value.kind, ["shell", "agent"], "terminal kind"),
  };
}

export function finite(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value))
    throw new Error(`Invalid ${field}`);
  return value;
}

export function usage(value: Wire.UsageSnapshot_Serialize): UsageSnapshot {
  const providerUsage = (
    provider: Wire.ProviderUsage_Serialize,
  ): Model.ProviderUsage => ({
    ...provider,
    status: member(
      provider.status,
      ["ok", "stale", "auth", "missing", "error"],
      "usage status",
    ),
    windows: provider.windows.map((window) => ({
      ...window,
      usedPercent: finite(window.usedPercent, "quota percentage"),
      windowMinutes: finite(window.windowMinutes, "quota duration"),
    })),
  });
  return {
    ...value,
    providers: value.providers.map(providerUsage),
    accounts: value.accounts.map((account) => ({
      ...account,
      usage: providerUsage(account.usage),
    })),
  };
}

export function attachment(
  value: Wire.AttachResult_Serialize,
): Model.AttachResult {
  return {
    ...value,
    exit: value.exit && {
      ...value.exit,
      reason: member(
        value.exit.reason,
        ["normal", "killed", "suspended", "restarted", "failed"],
        "exit reason",
      ),
    },
  };
}

const fileStates = [
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
] as const;
export function changes(
  value: Wire.ChangesSummary_Serialize,
): Model.ChangesSummary {
  return {
    ...value,
    files: value.files.map((file) => ({
      ...file,
      status: member(file.status, fileStates, "file status"),
      index: member(file.index, [...fileStates, "none"], "index status"),
      worktree: member(
        file.worktree,
        [...fileStates, "none"],
        "worktree status",
      ),
    })),
  };
}

export function scm(value: Wire.ScmInfo_Serialize): Model.ScmInfo {
  return {
    ...value,
    state: member(
      value.state,
      [
        "clean",
        "merging",
        "rebasing",
        "cherry-picking",
        "reverting",
        "bisecting",
      ],
      "repository state",
    ),
  };
}

export function workspace(
  value: Wire.WorkspaceSnapshot_Serialize,
): Model.WorkspaceSnapshot {
  return {
    ...value,
    terminals: value.terminals.map((row) => ({
      ...row,
      kind: member(row.kind, ["shell", "agent"], "terminal kind"),
      surface:
        row.surface === null
          ? null
          : member(row.surface, ["grid", "canvas"], "terminal surface"),
    })),
  };
}

export function feed(value: Wire.FeedEvent_Serialize): Model.FeedEvent {
  return {
    ...value,
    kind: member(
      value.kind,
      ["prompt", "say", "think", "tool", "result", "usage", "notify"],
      "feed kind",
    ),
    op:
      value.op === undefined
        ? undefined
        : member(
            value.op,
            [
              "edit",
              "write",
              "read",
              "run",
              "search",
              "agent",
              "plan",
              "todo",
              "skill",
              "other",
            ],
            "feed operation",
          ),
    costUsd:
      value.costUsd === undefined
        ? undefined
        : finite(value.costUsd, "feed cost"),
  };
}

export function sessionFeed(
  value: Wire.SessionFeed_Serialize,
): Model.SessionFeed {
  return { ...value, events: value.events.map(feed) };
}

export function files(value: Wire.FilesActivity): Model.FilesActivity {
  return {
    ...value,
    events: value.events.map((event) => ({
      ...event,
      kind: member(
        event.kind,
        ["created", "modified", "deleted"],
        "file event kind",
      ),
    })),
  };
}

export function resources(value: Wire.ResourcesTick): Model.ResourcesTick {
  return {
    ...value,
    totalRssMb: finite(value.totalRssMb, "total memory"),
    systemAvailableMb: finite(value.systemAvailableMb, "available memory"),
    systemTotalMb: finite(value.systemTotalMb, "system memory"),
    perPty: value.perPty.map((pty) => ({
      ...pty,
      rssMb: finite(pty.rssMb, "terminal memory"),
      cpu: finite(pty.cpu, "terminal CPU"),
    })),
  };
}

export function hook(
  value: Wire.HookReport_Serialize,
): import("../lib/nativeHooks").NativeHookReport {
  const kind = member(
    value.event.kind,
    ["turn-start", "turn-end", "permission", "working", "session"],
    "hook kind",
  );
  if (kind === "permission") {
    if (typeof value.event.ask !== "string")
      throw new Error("Invalid permission prompt");
    return { ...value, event: { ...value.event, kind, ask: value.event.ask } };
  }
  return { ...value, event: { ...value.event, kind } };
}

export function portalMenu(value: Wire.PortalMenu): Model.PortalMenu {
  return {
    ...value,
    x: finite(value.x, "menu x"),
    y: finite(value.y, "menu y"),
  };
}

export function task(value: Wire.Task_Serialize): Work.WorkTask {
  return {
    ...value,
    links: {
      ...value.links,
      resources: value.links.resources.map((resource) => ({
        ...resource,
        kind: member(
          resource.kind,
          ["front", "checkpoint", "diff", "pull_request", "flow"],
          "resource kind",
        ),
      })),
    },
  };
}

export function taskPage(value: Wire.TaskPage_Serialize): Work.TaskPage {
  return { ...value, tasks: value.tasks.map(task) };
}

export function taskReview(value: Wire.TaskReview_Serialize): Work.TaskReview {
  return { ...value, task: task(value.task) };
}

export function taskQueue(
  value: Wire.TaskQueueResult_Serialize,
): Work.TaskQueueResult {
  return {
    ...value,
    task: task(value.task),
    items: legacyJson<QueueItem[]>(value.items),
  };
}

export function queueResult(
  value: Wire.DispatchResult_Serialize,
): NativeQueueResult {
  return {
    ...value,
    status: member(
      value.status,
      ["delivered", "skipped", "uncertain"],
      "queue status",
    ),
    items: legacyJson<QueueItem[]>(value.items),
  };
}

export function checkpoint(value: Wire.Preview_Serialize): CheckpointPreview {
  return {
    ...value,
    files: value.files.map((file) => ({
      ...file,
      status: member(
        file.status,
        ["added", "modified", "deleted"],
        "checkpoint status",
      ),
    })),
  };
}

function rate<T extends Wire.CustomRate>(value: T) {
  return {
    ...value,
    input: finite(value.input, "input price"),
    output: finite(value.output, "output price"),
    cacheRead: finite(value.cacheRead, "cache read price"),
    cacheWriteFiveMinute: finite(
      value.cacheWriteFiveMinute,
      "cache write price",
    ),
    cacheWriteOneHour: finite(value.cacheWriteOneHour, "cache write price"),
  };
}

export function pricing(
  value: Wire.PricingReference_Serialize,
): Pricing.PricingReference {
  return { ...value, models: value.models.map(rate) };
}

export function pricingSettings(
  value: Wire.PricingSettings,
): Pricing.PricingSettings {
  return { ...value, rates: value.rates.map(rate) };
}

/**
 * Existing persisted JSON documents have no Rust DTO yet. Keep their legacy
 * frontend schema explicit at this boundary, rather than claiming generation
 * validates it. Typed Rust responses must use a concrete refinement above.
 */
export function legacyJson<T>(value: Wire.Value): T {
  return value as T;
}

/** JSON transport already removes undefined object properties and copies arrays. */
export function jsonPayload(value: unknown): Wire.Value {
  return JSON.parse(JSON.stringify(value)) as Wire.Value;
}
