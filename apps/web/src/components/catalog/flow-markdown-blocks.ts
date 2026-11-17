/**
 * A Flow package's markdown, split into the blocks the Flows page renders:
 * headings, paragraphs, lists, fenced code, and numbered procedure steps with
 * their `Done when:` outcome. Each block and item carries the line it starts
 * on, which keys it.
 */

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/u;
const LINE_ENDING = /\r\n?/gu;
const STEP = /^\d+[.)]\s+/u;
const BULLET = /^[-*]\s+/u;
const FENCE = /^```/u;
const HEADING = /^(?<marks>#{1,6})\s+(?<text>.*)$/u;
const DONE_WHEN = /^Done when:\s*/u;
const INDENTED = /^\s{2,}\S/u;

export interface Step {
  readonly doneWhen: string | undefined;
  readonly line: number;
  readonly text: string;
}

export interface ListItem {
  readonly line: number;
  readonly text: string;
}

export type Block = { readonly line: number } & (
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly ListItem[] }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "steps"; readonly items: readonly Step[] }
);

/** The body without its YAML frontmatter, which the page shows as values. */
export const markdownBody = (source: string): string =>
  source.replaceAll(LINE_ENDING, "\n").replace(FRONTMATTER, "");

interface Cursor {
  readonly lines: readonly string[];
  index: number;
}

const at = (cursor: Cursor, offset = 0): string =>
  cursor.lines[cursor.index + offset] ?? "";

const more = (cursor: Cursor): boolean => cursor.index < cursor.lines.length;

const readCode = (cursor: Cursor): Block => {
  const line = cursor.index;
  const code: string[] = [];
  cursor.index += 1;
  while (more(cursor) && !FENCE.test(at(cursor))) {
    code.push(at(cursor));
    cursor.index += 1;
  }
  cursor.index += 1;
  return { kind: "code", line, text: code.join("\n") };
};

/**
 * One step runs on through indented lines, and the blank lines between them,
 * until the next step or an unindented line.
 */
const readStep = (cursor: Cursor): Step => {
  const line = cursor.index;
  const text: string[] = [at(cursor).replace(STEP, "")];
  let doneWhen: string | undefined;
  cursor.index += 1;
  while (
    more(cursor) &&
    (INDENTED.test(at(cursor)) ||
      (at(cursor).trim() === "" && INDENTED.test(at(cursor, 1))))
  ) {
    const content = at(cursor).trim();
    if (DONE_WHEN.test(content)) {
      doneWhen = content.replace(DONE_WHEN, "");
    } else if (content !== "") {
      text.push(content);
    }
    cursor.index += 1;
  }
  return { doneWhen, line, text: text.join(" ") };
};

const readSteps = (cursor: Cursor): Block => {
  const line = cursor.index;
  const items: Step[] = [];
  while (more(cursor) && STEP.test(at(cursor))) {
    items.push(readStep(cursor));
    while (at(cursor).trim() === "" && STEP.test(at(cursor, 1))) {
      cursor.index += 1;
    }
  }
  return { items, kind: "steps", line };
};

const readList = (cursor: Cursor): Block => {
  const line = cursor.index;
  const items: ListItem[] = [];
  while (more(cursor) && BULLET.test(at(cursor))) {
    items.push({ line: cursor.index, text: at(cursor).replace(BULLET, "") });
    cursor.index += 1;
  }
  return { items, kind: "list", line };
};

const startsBlock = (text: string): boolean =>
  text.trim() === "" ||
  HEADING.test(text) ||
  STEP.test(text) ||
  BULLET.test(text) ||
  FENCE.test(text);

const readParagraph = (cursor: Cursor): Block => {
  const line = cursor.index;
  const text: string[] = [];
  while (more(cursor) && !startsBlock(at(cursor))) {
    text.push(at(cursor).trim());
    cursor.index += 1;
  }
  return { kind: "paragraph", line, text: text.join(" ") };
};

const readBlock = (cursor: Cursor): Block => {
  const text = at(cursor);
  const heading = HEADING.exec(text)?.groups;
  if (FENCE.test(text)) {
    return readCode(cursor);
  }
  if (heading !== undefined) {
    const line = cursor.index;
    cursor.index += 1;
    return {
      kind: "heading",
      level: heading.marks?.length ?? 1,
      line,
      text: heading.text ?? "",
    };
  }
  if (STEP.test(text)) {
    return readSteps(cursor);
  }
  if (BULLET.test(text)) {
    return readList(cursor);
  }
  return readParagraph(cursor);
};

export const markdownBlocks = (source: string): readonly Block[] => {
  const cursor: Cursor = { index: 0, lines: markdownBody(source).split("\n") };
  const blocks: Block[] = [];
  while (more(cursor)) {
    if (at(cursor).trim() === "") {
      cursor.index += 1;
    } else {
      blocks.push(readBlock(cursor));
    }
  }
  return blocks;
};

const INLINE =
  /(?<code>`[^`]+`)|(?<bold>\*\*[^*]+\*\*)|(?<link>\[(?<label>[^\]]+)\]\((?<href>[^)]+)\))/gu;

/** A run of text inside a block, at its character offset. */
export type Inline = { readonly offset: number } & (
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | {
      readonly href: string;
      readonly kind: "link";
      readonly text: string;
    }
);

const inlineMatch = (match: RegExpMatchArray, offset: number): Inline => {
  const { bold, code, href = "", label = "" } = match.groups ?? {};
  if (code !== undefined) {
    return { kind: "code", offset, text: code.slice(1, -1) };
  }
  if (bold !== undefined) {
    return { kind: "bold", offset, text: bold.slice(2, -2) };
  }
  return { href, kind: "link", offset, text: label };
};

/** Splits a block's text into plain runs, inline code, bold, and links. */
export const inlineRuns = (text: string): readonly Inline[] => {
  const runs: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > last) {
      runs.push({ kind: "text", offset: last, text: text.slice(last, start) });
    }
    runs.push(inlineMatch(match, start));
    last = start + match[0].length;
  }
  if (last < text.length) {
    runs.push({ kind: "text", offset: last, text: text.slice(last) });
  }
  return runs;
};
