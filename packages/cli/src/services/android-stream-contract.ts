export { AndroidStreamPacket } from "@contingency/protocol";

/**
 * Pinned display transport. Its stream feeds viewers and the session's
 * recorder, which muxes the stream with the hub's `ScreenRecording`. The hub
 * dashboard and its session recorder are never loaded.
 */
export const androidStreamRelease = {
  hub: "0.26.1",
  scrcpy: "4.0",
  sha256: "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a",
} as const;

/** Inspect the focused window only. Unknown visibility fails closed. */
export const androidWindowVisibility = (
  windows: string
): "visible" | "secure" | "unknown" => {
  const focus = /mCurrentFocus=Window\{(?<id>[^\s}]+)/u.exec(windows)?.groups
    ?.id;
  if (!focus) {
    return "unknown";
  }
  const section = windows
    .split(/\n\s*Window #\d+ /u)
    .find((part) => part.startsWith(`Window{${focus} `));
  const flags = section
    ?.match(/\bfl=(?<flags>[^\r\n}]+)/u)
    ?.groups?.flags?.trim();
  if (!flags) {
    return "unknown";
  }
  if (/\b(?:FLAG_)?SECURE\b/u.test(flags)) {
    return "secure";
  }
  if (/^(?:0x)?[\da-f]+$/iu.test(flags)) {
    // oxlint-disable-next-line eslint/no-bitwise -- Android window flag mask.
    return (Number.parseInt(flags.replace(/^0x/u, ""), 16) & 0x20_00) === 0
      ? "visible"
      : "secure";
  }
  return "visible";
};

export type AndroidWindowVisibility = ReturnType<
  typeof androidWindowVisibility
>;

/**
 * What viewers see for the focused window's visibility once it is reported.
 * Unknown visibility hides frames; only a stopped stream is `lost`.
 */
export const androidVisibilityState = (
  visibility: AndroidWindowVisibility
): "connecting" | "secure" | "unclassified" => {
  if (visibility === "secure") {
    return "secure";
  }
  return visibility === "unknown" ? "unclassified" : "connecting";
};

/**
 * Consecutive unknown reads before unknown visibility is reported. Android
 * reports no focused window for a moment between windows, which a single read
 * catches; two reads a second apart do not both land in one such moment.
 */
export const UNKNOWN_READS_REPORTED = 2;

/** The visibility viewers were last told, and the unknown reads since. */
export interface AndroidVisibilityReport {
  readonly reported: AndroidWindowVisibility | undefined;
  readonly unknownReads: number;
}

/** One read folded into the report, and what viewers are told for it. */
export interface AndroidVisibilityRead {
  readonly report: AndroidVisibilityReport;
  readonly changed: AndroidWindowVisibility | undefined;
}

export const initialAndroidVisibilityReport: AndroidVisibilityReport = {
  reported: undefined,
  unknownReads: 0,
};

/**
 * Folds one visibility read into the report. `changed` is the visibility to
 * tell viewers, or undefined when they keep what they have. A short unknown
 * between windows is never reported, so the viewer keeps its last frame;
 * frames are withheld for it all the same.
 */
export const reportAndroidVisibility = (
  report: AndroidVisibilityReport,
  read: AndroidWindowVisibility
): AndroidVisibilityRead => {
  const unknownReads = read === "unknown" ? report.unknownReads + 1 : 0;
  const settled = read !== "unknown" || unknownReads >= UNKNOWN_READS_REPORTED;
  if (!settled || read === report.reported) {
    return { changed: undefined, report: { ...report, unknownReads } };
  }
  return { changed: read, report: { reported: read, unknownReads } };
};
