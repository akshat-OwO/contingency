export { AndroidStreamPacket } from "@contingency/protocol";

/** Pinned display transport. The hub dashboard and recorder are never loaded. */
export const androidStreamRelease = {
  hub: "0.15.3",
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

/**
 * What a device recording keeps out of its video. Only a focused window counts:
 * between windows nothing has focus and nothing needs hiding, so a recording
 * hides a secure focused window, or a focused window it cannot classify.
 * `screenrecord` draws secure windows black either way.
 */
export const recordedWindowVisibility = (
  windows: string
): "visible" | "secure" | "unknown" =>
  /mCurrentFocus=null\b/u.test(windows)
    ? "visible"
    : androidWindowVisibility(windows);

/**
 * What viewers see for the focused window's visibility. Unknown visibility
 * hides frames until the next read; only a stopped stream is `lost`.
 */
export const androidVisibilityState = (
  visibility: "visible" | "secure" | "unknown"
): "connecting" | "secure" =>
  visibility === "secure" ? "secure" : "connecting";
