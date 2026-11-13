import { Data, Effect, FileSystem, Option } from "effect";

/** An MP4 whose video track could not be read. */
export class Mp4FramesError extends Data.TaggedError("Mp4FramesError")<{
  readonly message: string;
}> {}

/** What a recording's video track says about its frames. */
export interface Mp4Frames {
  /** The sample entry's four-character code, such as `avc1` or `hvc1`. */
  readonly codec: string;
  /** Presentation time of every frame, in milliseconds, ascending. */
  readonly frames: readonly number[];
  /** How long the track plays, in milliseconds. */
  readonly durationMs: number;
  readonly height: number;
  readonly width: number;
}

interface Box {
  readonly type: string;
  /** Offset of the box's contents, after its header. */
  readonly start: number;
  readonly end: number;
}

/** The most a moov box may hold; a recording's tables stay far below it. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

const fail = (message: string) => new Mp4FramesError({ message });

const children = (view: DataView, start: number, end: number): Box[] => {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCodePoint(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        break;
      }
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      break;
    }
    boxes.push({ end: offset + size, start: offset + header, type });
    offset += size;
  }
  return boxes;
};

const child = (view: DataView, box: Box, type: string) =>
  children(view, box.start, box.end).find((entry) => entry.type === type);

const path = (view: DataView, box: Box, types: readonly string[]) => {
  let current: Box | undefined = box;
  for (const type of types) {
    current = current === undefined ? undefined : child(view, current, type);
  }
  return current;
};

/**
 * How long a track plays: the shortest duration its headers and sample table
 * claim that still reaches its last frame. A recorder that was stopped can
 * leave one of them unset or holding a placeholder.
 */
const playedFor = (lastFrame: number, claims: readonly number[]): number =>
  Math.min(
    ...claims.filter((claim) => Number.isFinite(claim) && claim >= lastFrame),
    Number.POSITIVE_INFINITY
  ) === Number.POSITIVE_INFINITY
    ? lastFrame
    : Math.min(
        ...claims.filter(
          (claim) => Number.isFinite(claim) && claim >= lastFrame
        )
      );

const fourCc = (view: DataView, at: number) =>
  String.fromCodePoint(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  );

/** A full box's timescale and duration, for `mvhd` and `mdhd` alike. */
const timing = (view: DataView, box: Box) => {
  const wide = view.getUint8(box.start) === 1;
  return {
    duration: wide
      ? Number(view.getBigUint64(box.start + 24))
      : view.getUint32(box.start + 16),
    timescale: wide
      ? view.getUint32(box.start + 20)
      : view.getUint32(box.start + 12),
  };
};

/** Each sample's decode time, from `stts`, and the time after the last. */
const decodeTimes = (view: DataView, stts: Box) => {
  const times: number[] = [];
  let time = 0;
  const entries = view.getUint32(stts.start + 4);
  for (let index = 0; index < entries; index += 1) {
    const at = stts.start + 8 + index * 8;
    if (at + 8 > stts.end) {
      throw fail("The recording's timing table is truncated.");
    }
    const count = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    for (let sample = 0; sample < count; sample += 1) {
      times.push(time);
      time += delta;
    }
  }
  return { end: time, times };
};

/** Each sample's composition offset, from `ctts` when there is one. */
const compositionOffsets = (view: DataView, ctts: Box | undefined) => {
  const offsets: number[] = [];
  if (ctts === undefined) {
    return offsets;
  }
  const signed = view.getUint8(ctts.start) === 1;
  const count = view.getUint32(ctts.start + 4);
  for (let index = 0; index < count; index += 1) {
    const at = ctts.start + 8 + index * 8;
    if (at + 8 > ctts.end) {
      break;
    }
    const samples = view.getUint32(at);
    const offset = signed ? view.getInt32(at + 4) : view.getUint32(at + 4);
    for (let sample = 0; sample < samples; sample += 1) {
      offsets.push(offset);
    }
  }
  return offsets;
};

/**
 * The first non-empty edit: the media time the track starts from, and the
 * empty edits before it, in seconds.
 */
const firstEdit = (
  view: DataView,
  elst: Box | undefined,
  movieTimescale: number
) => {
  let empty = 0;
  if (elst === undefined) {
    return { empty, shift: 0 };
  }
  const wide = view.getUint8(elst.start) === 1;
  const count = view.getUint32(elst.start + 4);
  const width = wide ? 20 : 12;
  for (let index = 0; index < count; index += 1) {
    const at = elst.start + 8 + index * width;
    if (at + width > elst.end) {
      break;
    }
    const segment = wide ? Number(view.getBigUint64(at)) : view.getUint32(at);
    const media = wide
      ? Number(view.getBigInt64(at + 8))
      : view.getInt32(at + 4);
    if (media !== -1) {
      return { empty, shift: media };
    }
    empty += movieTimescale > 0 ? segment / movieTimescale : 0;
  }
  return { empty, shift: 0 };
};

const isVideoTrack = (view: DataView, trak: Box) => {
  const mdia = child(view, trak, "mdia");
  const hdlr = mdia === undefined ? undefined : child(view, mdia, "hdlr");
  return hdlr !== undefined && fourCc(view, hdlr.start + 8) === "vide";
};

/** A track's codec, from its sample entry, and its frame size, from its header. */
const trackFormat = (view: DataView, trak: Box, stbl: Box) => {
  const tkhd = child(view, trak, "tkhd");
  const stsd = child(view, stbl, "stsd");
  return {
    codec:
      stsd !== undefined && stsd.start + 16 <= stsd.end
        ? fourCc(view, stsd.start + 12)
        : "",
    height: Math.round(
      tkhd === undefined ? 0 : view.getUint32(tkhd.end - 4) / 65_536
    ),
    width: Math.round(
      tkhd === undefined ? 0 : view.getUint32(tkhd.end - 8) / 65_536
    ),
  };
};

/** Reads one video track's frames. */
const trackFrames = (
  view: DataView,
  trak: Box,
  movie: { readonly timescale: number; readonly durationMs: number }
): Mp4Frames => {
  const mdia = child(view, trak, "mdia");
  const mdhd = mdia === undefined ? undefined : child(view, mdia, "mdhd");
  const stbl =
    mdia === undefined ? undefined : path(view, mdia, ["minf", "stbl"]);
  const stts = stbl === undefined ? undefined : child(view, stbl, "stts");
  if (mdhd === undefined || stbl === undefined || stts === undefined) {
    throw fail("The recording's video track has no timing tables.");
  }
  const media = timing(view, mdhd);
  if (media.timescale === 0) {
    throw fail("The recording's video track has no timescale.");
  }
  const decoded = decodeTimes(view, stts);
  const offsets = compositionOffsets(view, child(view, stbl, "ctts"));
  const { empty, shift } = firstEdit(
    view,
    path(view, trak, ["edts", "elst"]),
    movie.timescale
  );
  const toMs = (ticks: number) =>
    ((ticks - shift) / media.timescale + empty) * 1000;
  const frames: number[] = [];
  // Where the last-presented sample ends, which composition offsets move
  // past the decode timeline's own end.
  let presentedEnd = 0;
  for (const [index, decode] of decoded.times.entries()) {
    const presented = decode + (offsets[index] ?? 0);
    const next = decoded.times[index + 1] ?? decoded.end;
    presentedEnd = Math.max(presentedEnd, presented + (next - decode));
    const ms = toMs(presented);
    // A sample stamped past the movie's own duration is a recorder's
    // placeholder, such as simctl's final sample, not a frame to show.
    if (
      Number.isFinite(ms) &&
      ms >= 0 &&
      !(movie.durationMs > 0 && ms > movie.durationMs + 1000)
    ) {
      frames.push(ms);
    }
  }
  const unique = frames
    .toSorted((left, right) => left - right)
    .filter((ms, index, sorted) => index === 0 || ms !== sorted[index - 1]);
  if (unique.length === 0) {
    throw fail("The recording holds no video frames.");
  }
  return {
    ...trackFormat(view, trak, stbl),
    durationMs: playedFor(unique.at(-1) ?? 0, [
      toMs(presentedEnd),
      toMs(media.duration),
      movie.durationMs,
    ]),
    frames: unique,
  };
};

/**
 * Read the frames of the first video track from an MP4's `moov` contents:
 * sample durations (`stts`), composition offsets (`ctts`), and the first edit
 * of an edit list (`elst`), so each time is where a player presents it.
 */
export const parseMp4Moov = (moov: Uint8Array): Mp4Frames => {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root: Box = { end: moov.byteLength, start: 0, type: "moov" };
  const mvhd = child(view, root, "mvhd");
  const movie =
    mvhd === undefined ? { duration: 0, timescale: 0 } : timing(view, mvhd);
  const durationMs =
    movie.timescale > 0
      ? (movie.duration / movie.timescale) * 1000
      : Number.NaN;
  const trak = children(view, 0, moov.byteLength).find(
    (box) => box.type === "trak" && isVideoTrack(view, box)
  );
  if (trak === undefined) {
    throw fail("The recording has no video track.");
  }
  return trackFrames(view, trak, { durationMs, timescale: movie.timescale });
};

/**
 * Read a recording's frame times without reading its footage: only the
 * top-level box headers and the `moov` box are read from disk.
 */
export const readMp4Frames = (
  file: string
): Effect.Effect<Mp4Frames, Mp4FramesError, FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* readFrames() {
      const fileSystem = yield* FileSystem.FileSystem;
      const handle = yield* fileSystem
        .open(file, { flag: "r" })
        .pipe(
          Effect.mapError(() => fail("The recording could not be opened."))
        );
      const size = Number(
        (yield* handle.stat.pipe(
          Effect.mapError(() => fail("The recording could not be read."))
        )).size
      );
      const read = (at: number, length: number) =>
        Effect.gen(function* readRange() {
          yield* handle
            .seek(BigInt(at), "start")
            .pipe(
              Effect.mapError(() => fail("The recording could not be read."))
            );
          const bytes = yield* handle
            .readAlloc(length)
            .pipe(
              Effect.mapError(() => fail("The recording could not be read."))
            );
          return Option.getOrElse(bytes, () => new Uint8Array());
        });
      let offset = 0;
      while (offset + 8 <= size) {
        const header = yield* read(offset, 16);
        if (header.byteLength < 8) {
          break;
        }
        const view = new DataView(
          header.buffer,
          header.byteOffset,
          header.byteLength
        );
        let boxSize = view.getUint32(0);
        let headerSize = 8;
        const type = String.fromCodePoint(
          view.getUint8(4),
          view.getUint8(5),
          view.getUint8(6),
          view.getUint8(7)
        );
        if (boxSize === 1 && header.byteLength >= 16) {
          boxSize = Number(view.getBigUint64(8));
          headerSize = 16;
        } else if (boxSize === 0) {
          boxSize = size - offset;
        }
        if (boxSize < headerSize) {
          break;
        }
        if (type === "moov") {
          const length = boxSize - headerSize;
          if (length > MAX_MOOV_BYTES) {
            return yield* Effect.fail(
              fail("The recording's index is too large to read.")
            );
          }
          const moov = yield* read(offset + headerSize, length);
          return yield* Effect.try({
            catch: (cause) =>
              cause instanceof Mp4FramesError
                ? cause
                : fail("The recording's index could not be read."),
            try: () => parseMp4Moov(moov),
          });
        }
        offset += boxSize;
      }
      return yield* Effect.fail(
        fail("The recording has no index; it may not have been finished.")
      );
    })
  );
