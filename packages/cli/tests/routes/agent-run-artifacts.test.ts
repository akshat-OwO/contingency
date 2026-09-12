import { expect, it } from "@effect/vitest";

import { parseByteRange } from "../../src/routes/agent-run-artifacts.ts";

it("reads the one byte range a media element asks for", () => {
  expect(parseByteRange("bytes=0-99", 500)).toEqual({ end: 99, start: 0 });
  // An open end is the rest of the file, which is what a seek sends.
  expect(parseByteRange("bytes=200-", 500)).toEqual({ end: 499, start: 200 });
  // A suffix range asks for the last bytes, where a WebM keeps its Cues.
  expect(parseByteRange("bytes=-100", 500)).toEqual({ end: 499, start: 400 });
  // Past the end, malformed, absent, or multi-range: serve the whole file.
  expect(parseByteRange("bytes=900-999", 500)).toBeUndefined();
  expect(parseByteRange("bytes=0-99,200-299", 500)).toBeUndefined();
  expect(parseByteRange(undefined, 500)).toBeUndefined();
  expect(parseByteRange("bytes=0-99", 0)).toBeUndefined();
});
