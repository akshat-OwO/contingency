declare global {
  interface Uint8ArrayConstructor {
    /** The browser's own base64 decoder, absent in older browsers. */
    readonly fromBase64?: (data: string) => Uint8Array<ArrayBuffer>;
  }
}

/** Base64 holds only single-byte characters. */
const copyCharacters = (data: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(data), (character) => character.codePointAt(0) ?? 0);

/**
 * Decodes base64 to bytes. A live device frame arrives as base64, and the
 * browser's built-in decoder reads a 90 KB iOS frame in about 0.1 ms, where
 * `atob` and a per-character copy take about 2.4 ms on the main thread. A
 * browser without it takes the copy.
 */
export const decodeBase64 = (data: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.fromBase64 === undefined
    ? copyCharacters(data)
    : Uint8Array.fromBase64(data);
