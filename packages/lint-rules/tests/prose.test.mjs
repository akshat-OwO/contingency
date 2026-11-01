import { describe, expect, it } from "vitest";

import { countSentences, findHeavyBlocks, proseBlocks } from "../src/prose.mjs";

const sentences = (count) =>
  Array.from({ length: count }, (_, index) => `Step ${index} holds.`).join(" ");

describe("findHeavyBlocks", () => {
  it("accepts short paragraphs and list items", () => {
    expect(
      findHeavyBlocks(`# Title\n\n${sentences(3)}\n\n- ${sentences(2)}\n`)
    ).toEqual([]);
  });

  it("flags a paragraph over three sentences on its first line", () => {
    expect(
      findHeavyBlocks(`# Title\n\n${sentences(2)}\n${sentences(2)}\n`)
    ).toEqual([{ line: 3, sentences: 4, words: 12 }]);
  });

  it("flags a list item over sixty words", () => {
    const words = Array.from({ length: 61 }, () => "word").join(" ");
    expect(findHeavyBlocks(`1. ${words}\n`)).toEqual([
      { line: 1, sentences: 1, words: 61 },
    ]);
  });

  it("treats an indented continuation as its own block", () => {
    expect(proseBlocks(`1. First.\n\n   ${sentences(2)}\n`)).toHaveLength(2);
  });

  it("skips code fences, tables, headings, and frontmatter", () => {
    const heavy = sentences(5);
    const markdown = `---\nname: x\n---\n# ${heavy}\n\n\`\`\`\n${heavy}\n\`\`\`\n\n| ${heavy} |\n`;
    expect(findHeavyBlocks(markdown)).toEqual([]);
  });

  it("does not end sentences inside code spans or abbreviations", () => {
    expect(countSentences("Call `a.b. c.d.` e.g. now, i.e. once.")).toBe(1);
  });
});
