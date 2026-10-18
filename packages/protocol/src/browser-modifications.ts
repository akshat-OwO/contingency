import { Schema } from "effect";

import { PageZoom, TextScale } from "./emulation.ts";

const text = Schema.String.check(Schema.isMinLength(1));
/** Public evidence only. Values needed for restoration never enter this record. */
export const BrowserModification = Schema.Struct({
  actor: Schema.Literal("agent"),
  at: text,
  description: text,
  id: text,
  kind: Schema.Literals([
    "cookie",
    "storage",
    "route",
    "headers",
    "emulation",
    "eval",
    "clipboard",
    "upload",
  ]),
  operationId: text,
  pageZoom: Schema.optionalKey(PageZoom),
  removedAt: Schema.optionalKey(text),
  routeAction: Schema.optionalKey(Schema.Literals(["mock", "block"])),
  textScale: Schema.optionalKey(TextScale),
});
export type BrowserModification = typeof BrowserModification.Type;

export const browserModificationSummary = (
  modifications: readonly BrowserModification[]
): string => {
  const active = modifications.filter((mod) => mod.removedAt === undefined);
  const parts: string[] = [];
  const count = (
    kind: BrowserModification["kind"],
    action?: "mock" | "block"
  ) =>
    active.filter(
      (mod) =>
        mod.kind === kind &&
        (action === undefined || mod.routeAction === action)
    ).length;
  for (const [n, singular] of [
    [count("route", "mock"), "mocked route"],
    [count("route", "block"), "blocked route"],
    [count("cookie"), "cookie"],
    [count("storage"), "storage change"],
    [count("eval"), "evaluation"],
    [count("upload"), "upload"],
  ] as const) {
    if (n > 0) {
      parts.push(`${n} ${singular}${n === 1 ? "" : "s"}`);
    }
  }
  if (count("headers") > 0) {
    parts.push("headers");
  }
  if (count("clipboard") > 0) {
    parts.push("clipboard");
  }
  const textScale = active.findLast(
    (mod) => mod.textScale !== undefined
  )?.textScale;
  const pageZoom = active.findLast(
    (mod) => mod.pageZoom !== undefined
  )?.pageZoom;
  if (textScale !== undefined) {
    parts.push(`${textScale}% text`);
  }
  if (pageZoom !== undefined) {
    parts.push(`${pageZoom}% zoom`);
  }
  return parts.join(" · ");
};
