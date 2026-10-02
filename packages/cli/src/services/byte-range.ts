export interface ByteRange {
  readonly end: number;
  readonly start: number;
}

/**
 * The single byte range a request asked for, or `undefined` for the whole
 * file. Only the one-range form is honoured, which is the only form a media
 * element sends.
 */
export const parseByteRange = (
  header: string | undefined,
  size: number
): ByteRange | undefined => {
  const match = /^bytes=(?<start>\d*)-(?<end>\d*)$/u.exec(header?.trim() ?? "");
  if (match === null || size === 0) {
    return undefined;
  }
  const { end, start } = match.groups ?? {};
  if (
    start === undefined ||
    end === undefined ||
    (start === "" && end === "")
  ) {
    return undefined;
  }
  // A suffix range — `bytes=-1024` — asks for the file's last N bytes.
  const from = start === "" ? Math.max(size - Number(end), 0) : Number(start);
  const to =
    start === "" || end === "" ? size - 1 : Math.min(Number(end), size - 1);
  return from > to || from >= size ? undefined : { end: to, start: from };
};
