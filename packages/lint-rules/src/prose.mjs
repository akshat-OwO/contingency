/**
 * Agent-facing Markdown stays scannable: every prose block, whether a
 * paragraph, a list item, or an indented continuation, holds at most
 * `MAX_SENTENCES` sentences and `MAX_WORDS` words. Oxlint parses only
 * JavaScript, so this rule runs beside it in the root `lint` script.
 */

export const MAX_SENTENCES = 3;
export const MAX_WORDS = 60;

const FENCE = /^\s*(?:```|~~~)/u;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/u;
const HEADING = /^\s*#{1,6}\s/u;
const TABLE = /^\s*\|/u;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf)\./giu;

/** Visible words of one block: code spans, link targets, and markup removed. */
const visibleText = (text) =>
  text
    .replaceAll(/`[^`]*`/gu, "code")
    .replaceAll(/!?\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>")
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll(ABBREVIATIONS, "abbr")
    .replaceAll(/[*_]{1,3}/gu, "");

export const countWords = (text) =>
  visibleText(text).split(/\s+/u).filter(Boolean).length;

export const countSentences = (text) => {
  const ends = visibleText(text).match(/[.!?]+(?=["')\]]*(?:\s|$))/gu);
  return Math.max(ends?.length ?? 0, text.trim() === "" ? 0 : 1);
};

/** Prose blocks with the 1-based line each starts on. */
export const proseBlocks = (markdown) => {
  const blocks = [];
  let current = null;
  let fenced = false;
  let frontmatter = false;
  const close = () => {
    if (current !== null) {
      blocks.push(current);
      current = null;
    }
  };
  for (const [index, line] of markdown.split("\n").entries()) {
    if (index === 0 && line.trim() === "---") {
      frontmatter = true;
      continue;
    }
    if (frontmatter) {
      frontmatter = line.trim() !== "---";
      continue;
    }
    if (FENCE.test(line)) {
      close();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    if (line.trim() === "" || HEADING.test(line) || TABLE.test(line)) {
      close();
      continue;
    }
    if (LIST_ITEM.test(line)) {
      close();
      current = { line: index + 1, text: line.replace(LIST_ITEM, "") };
      continue;
    }
    if (current === null) {
      current = { line: index + 1, text: line.trim() };
    } else {
      current.text += ` ${line.trim()}`;
    }
  }
  close();
  return blocks;
};

/** One finding per prose block over either limit. */
export const findHeavyBlocks = (markdown) =>
  proseBlocks(markdown).flatMap(({ line, text }) => {
    const sentences = countSentences(text);
    const words = countWords(text);
    return sentences > MAX_SENTENCES || words > MAX_WORDS
      ? [{ line, sentences, words }]
      : [];
  });
