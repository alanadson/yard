/**
 * A session as a document — the events of `agents/tail.rs` turned into the
 * blocks a person reads: the prompt, the answer, the tools between them (one
 * block per run of calls, each call glued to its result by id), thinking
 * kept apart so the view can fold it. Nothing here touches the disk or the
 * DOM; `TranscriptModal` only paints what comes out.
 */
import { t } from "./i18n";
import type { AgentSession, FeedEvent, FeedOp } from "./ipc";
import { fold } from "./search";

export interface ToolItem {
  toolId?: string;
  tool: string;
  op?: FeedOp;
  path?: string;
  detail?: string;
  added?: number;
  removed?: number;
  /** `null` while no result arrived (the session ended mid-call). */
  ok: boolean | null;
  result?: string;
  side?: boolean;
}

export type Block =
  | { kind: "prompt"; at: number; text: string; side?: boolean }
  | { kind: "say"; at: number; text: string; side?: boolean }
  | { kind: "think"; at: number; text: string; side?: boolean }
  | { kind: "notify"; at: number; text: string }
  | { kind: "tools"; at: number; items: ToolItem[] };

/** The events as blocks, in order; usage lines carry no prose and are dropped. */
export function transcriptBlocks(events: readonly FeedEvent[]): Block[] {
  const blocks: Block[] = [];
  /** Open tool calls by id — a result attaches to the call it answers. */
  const open = new Map<string, ToolItem>();
  let run: { kind: "tools"; at: number; items: ToolItem[] } | null = null;

  for (const ev of events) {
    switch (ev.kind) {
      case "tool": {
        const item: ToolItem = {
          toolId: ev.toolId,
          tool: ev.tool ?? ev.op ?? "tool",
          op: ev.op,
          path: ev.path,
          detail: ev.detail,
          added: ev.added,
          removed: ev.removed,
          ok: null,
          side: ev.side,
        };
        if (!run) {
          run = { kind: "tools", at: ev.at, items: [] };
          blocks.push(run);
        }
        run.items.push(item);
        if (ev.toolId) open.set(ev.toolId, item);
        break;
      }
      case "result": {
        // A result does not break the run: the next call still joins it.
        const item = ev.toolId ? open.get(ev.toolId) : undefined;
        if (item) {
          item.ok = ev.ok !== false;
          if (ev.text) item.result = ev.text;
          if (ev.toolId) open.delete(ev.toolId);
        }
        break;
      }
      case "prompt":
      case "say":
      case "think": {
        run = null;
        blocks.push({ kind: ev.kind, at: ev.at, text: ev.text ?? "", side: ev.side });
        break;
      }
      case "notify": {
        run = null;
        blocks.push({ kind: "notify", at: ev.at, text: ev.text ?? "" });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function blockText(b: Block): string {
  if (b.kind === "tools") {
    return b.items
      .map((i) => [i.tool, i.path, i.detail, i.result].filter(Boolean).join(" "))
      .join("\n");
  }
  return b.text;
}

/** Indexes of the blocks whose text holds the query, accents ignored. */
export function searchTranscript(blocks: readonly Block[], query: string): number[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const out: number[] = [];
  blocks.forEach((b, i) => {
    if (fold(blockText(b)).includes(needle)) out.push(i);
  });
  return out;
}

export function transcriptTitle(
  session: Pick<AgentSession, "title" | "externalId">,
): string {
  return session.title?.trim() || t("sessão {id}", { id: session.externalId.slice(0, 8) });
}

function mark(item: ToolItem): string {
  return item.ok === null ? "…" : item.ok ? "✓" : "✗";
}

/** The transcript as Markdown — for the clipboard, a note, an issue. */
export function transcriptMarkdown(blocks: readonly Block[], title: string): string {
  const out: string[] = [`# ${title}`, ""];
  for (const b of blocks) {
    switch (b.kind) {
      case "prompt":
        out.push(...b.text.split(/\r?\n/).map((l) => `> ${l}`), "");
        break;
      case "say":
        out.push(b.text, "");
        break;
      case "think":
        out.push(`<details><summary>${t("pensando")}</summary>`, "", b.text, "", `</details>`, ""); // i18n-ok
        break;
      case "notify":
        out.push(`_${b.text}_`, "");
        break;
      case "tools":
        for (const i of b.items) {
          const what = [i.op ?? i.tool, i.path ? `\`${i.path}\`` : null, i.detail]
            .filter(Boolean)
            .join(" ");
          out.push(`- ${what} ${mark(i)}`);
        }
        out.push("");
        break;
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
