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
