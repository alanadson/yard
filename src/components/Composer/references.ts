/** Live canvas references use the agent CLI's connection and naming rules. */
import {
  connectedAgents,
  connectedNotes,
  connectedPortals,
  findMentions,
  type Ctx,
} from "../../lib/bridgeCore";
import { fold } from "../../lib/search";

export interface ComposerReference {
  id: string;
  kind: "agent" | "note" | "portal" | "file";
  name: string;
}

export function composerMentions(draft: string, names: string[]): string[] {
  const text = draft.replace(
    /@(?:note|portal)\("(?:\\.|[^"\\])*", id="(?:\\.|[^"\\])*"\)/g,
    " ",
  );
  return findMentions(text, names);
}

export interface ReferenceQuery {
  trigger: "@" | "#";
  query: string;
  at: number;
}

export function referenceQuery(
  text: string,
  caret: number,
): ReferenceQuery | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s([{,;])([@#])([^\n@#]*)$/.exec(before);
  if (!match) return null;
  return {
    trigger: match[1] as "@" | "#",
    query: match[2],
    at: before.length - match[2].length - 1,
  };
}

export function referenceText(reference: ComposerReference): string {
  if (reference.kind === "agent") return `@${reference.name}`;
  if (reference.kind === "file") return JSON.stringify(reference.id);
  return `@${reference.kind}(${JSON.stringify(reference.name)}, id=${JSON.stringify(reference.id)})`;
}

export function fileReferences(
  root: string,
  paths: readonly string[],
  query: string,
): ComposerReference[] {
  const prefix = root.replace(/\\/g, "/").replace(/\/$/, "");
  return paths
    .filter((path) => fold(path).includes(fold(query)))
    .slice(0, 20)
    .map((path) => ({ id: `${prefix}/${path}`, name: path, kind: "file" }));
}

export function composerReferences(ctx: Ctx): ComposerReference[] {
  return [
    ...connectedAgents(ctx).map((item) => ({
      id: item.id,
      kind: "agent" as const,
      name: ctx.nameOf.get(item.id)!,
    })),
    ...connectedNotes(ctx).map((item) => ({
      id: item.id,
      kind: "note" as const,
      name: ctx.noteNameOf.get(item.id)!,
    })),
    ...connectedPortals(ctx).map((item) => ({
      id: item.id,
      kind: "portal" as const,
      name: ctx.portalNameOf.get(item.id)!,
    })),
  ];
}
