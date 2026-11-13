import { describe, expect, it } from "vitest";

import { parseMp4Moov } from "../../src/services/mp4-frames.ts";

const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return [...bytes];
};

const i32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value);
  return [...bytes];
};

const zeros = (count: number) => Array.from({ length: count }, () => 0);

const ascii = (text: string) =>
  [...text].map((letter) => letter.codePointAt(0) ?? 0);

/** One box: its size, its type, and its contents. */
const box = (type: string, ...contents: number[][]): number[] => {
  const body = contents.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
};

/** A version-0 full box header. */
const full = (flags = 0) => [0, 0, 0, flags];

const mvhd = (timescale: number, duration: number) =>
  box("mvhd", full(), u32(0), u32(0), u32(timescale), u32(duration), zeros(80));

const mdhd = (timescale: number, duration: number) =>
  box("mdhd", full(), u32(0), u32(0), u32(timescale), u32(duration), u32(0));

/** A track header whose last eight bytes are its 16.16 width and height. */
const tkhd = (width: number, height: number) =>
  box("tkhd", full(), zeros(76), u32(width * 65_536), u32(height * 65_536));

const hdlr = (handler: string) =>
  box("hdlr", full(), u32(0), ascii(handler), zeros(12), [0]);

const stts = (entries: readonly [count: number, delta: number][]) =>
  box(
    "stts",
    full(),
    u32(entries.length),
    ...entries.map(([count, delta]) => [...u32(count), ...u32(delta)])
  );

const ctts = (entries: readonly [count: number, offset: number][]) =>
  box(
    "ctts",
    full(),
    u32(entries.length),
    ...entries.map(([count, offset]) => [...u32(count), ...u32(offset)])
  );

const stsd = (codec: string) =>
  box("stsd", full(), u32(1), box(codec, zeros(8)));

const elst = (entries: readonly [segment: number, media: number][]) =>
  box(
    "elst",
    full(),
    u32(entries.length),
    ...entries.map(([segment, media]) => [
      ...u32(segment),
      ...i32(media),
      0,
      1,
      0,
      0,
    ])
  );

const track = (options: {
  readonly handler?: string;
  readonly timing: number[];
  readonly offsets?: number[];
  readonly edits?: number[];
  readonly duration: number;
}) =>
  box(
    "trak",
    tkhd(1080, 2400),
    options.edits === undefined ? [] : box("edts", options.edits),
    box(
      "mdia",
      mdhd(1000, options.duration),
      hdlr(options.handler ?? "vide"),
      box(
        "minf",
        box("stbl", stsd("avc1"), options.timing, options.offsets ?? [])
      )
    )
  );

const moov = (...contents: number[][]) => Uint8Array.from(contents.flat());

describe("parseMp4Moov", () => {
  it("reads presentation times, size, codec, and duration", () => {
    const parsed = parseMp4Moov(
      moov(
        mvhd(1000, 3000),
        track({ duration: 3000, timing: stts([[3, 1000]]) })
      )
    );
    expect(parsed).toEqual({
      codec: "avc1",
      durationMs: 3000,
      frames: [0, 1000, 2000],
      height: 2400,
      width: 1080,
    });
  });

  it("applies composition offsets and the first edit, skipping other tracks", () => {
    const parsed = parseMp4Moov(
      moov(
        mvhd(1000, 2000),
        track({ duration: 2000, handler: "soun", timing: stts([[1, 2000]]) }),
        track({
          duration: 2200,
          edits: elst([[2000, 200]]),
          offsets: ctts([[2, 200]]),
          timing: stts([[2, 1000]]),
        })
      )
    );
    // Each frame is decoded at 0 and 1000, presented 200 later, and the
    // edit starts the track at media time 200.
    expect(parsed.frames).toEqual([0, 1000]);
    expect(parsed.durationMs).toBe(2000);
  });

  it("drops a placeholder sample stamped far past the movie's duration", () => {
    const parsed = parseMp4Moov(
      moov(
        mvhd(1000, 2000),
        track({
          duration: 2000,
          timing: stts([
            [1, 1000],
            [1, 62_000],
            [1, 1],
          ]),
        })
      )
    );
    expect(parsed.frames).toEqual([0, 1000]);
    expect(parsed.durationMs).toBe(2000);
  });

  it("refuses a file with no video track", () => {
    expect(() =>
      parseMp4Moov(
        moov(
          mvhd(1000, 1000),
          track({ duration: 1000, handler: "soun", timing: stts([[1, 1000]]) })
        )
      )
    ).toThrow("The recording has no video track.");
  });
});
