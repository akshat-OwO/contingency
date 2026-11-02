import path from "node:path";

import type { FlowSkillFile, FlowSkillName } from "@contingency/protocol";
import { Schema } from "effect";

/** Document paths never enter evidence directories, even through nested aliases. */
export const isFlowDocumentArea = (file: string): boolean =>
  file.length > 0 &&
  !file.includes("\\") &&
  !path.posix.isAbsolute(file) &&
  path.posix.normalize(file) === file &&
  !file.endsWith("/") &&
  !file.split("/").some((part) => ["..", "runs", "recordings"].includes(part));

export const isSupportingDocument = (file: string): boolean =>
  isFlowDocumentArea(file) && file.endsWith(".md") && file !== "flow.md";

export const isFlowDocument = (file: string): boolean =>
  file === "flow.md" ||
  isSupportingDocument(file) ||
  ["checks.json", "scans.json", "browser-state.json"].includes(file);

export const SupportingDocument = Schema.Struct({
  heading: Schema.NullOr(Schema.String),
  path: Schema.String,
});

export const FlowDocuments = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ content: Schema.String, path: Schema.String })
  ),
  supportingDocuments: Schema.Array(SupportingDocument),
});

/** Skip fenced examples and frontmatter when finding the first Markdown heading. */
const firstHeading = (content: string): string | null => {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "");
  let fence: string | undefined;
  let previous = "";
  for (const line of body.split(/\r?\n/u)) {
    const marker = /^ {0,3}(?<marker>`{3,}|~{3,})/u.exec(line)?.groups?.marker;
    if (marker !== undefined) {
      if (fence === undefined) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      previous = "";
      continue;
    }
    if (fence !== undefined) {
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:\s+|$)(?<heading>.*)$/u.exec(line)?.groups
      ?.heading;
    if (atx !== undefined) {
      return atx.replace(/\s+#+\s*$/u, "").trim();
    }
    if (previous.trim() && /^ {0,3}(?:=+|-+)\s*$/u.test(line)) {
      return previous.trim();
    }
    previous = line;
  }
  return null;
};

/** Runs receive the procedure and an index, with document bodies fetched as needed. */
export const flowDocuments = (files: readonly FlowSkillFile[]) => ({
  files: files.filter((file) => file.path === "flow.md"),
  supportingDocuments: files.flatMap((file) =>
    isSupportingDocument(file.path)
      ? [
          {
            heading: firstHeading(file.content),
            path: file.path,
          },
        ]
      : []
  ),
});

/** Delivery belongs to the operation receipt, not the persisted Run or session state. */
export interface FlowDocumentDelivery {
  readonly flowDocuments?: readonly ({
    readonly flowSkillName: FlowSkillName;
  } & ReturnType<typeof flowDocuments>)[];
}
