/** What a native stage's stream is doing, as its Stream diagnostics reads it. */
export type NativeStreamState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "secure"
  | "unclassified"
  | "lost"
  | "unsupported";

/**
 * Counts the stream keeps while it runs. They change every frame, so the
 * stream writes them to a ref and the open diagnostics card samples it,
 * rather than re-rendering the Workspace per frame.
 */
export interface NativeStreamStats {
  readonly codec: string | undefined;
  readonly decoded: number;
  readonly height: number;
  /** Times the viewer fell behind and rejoined at the next keyframe. */
  readonly resyncs: number;
  readonly width: number;
}

export const emptyNativeStreamStats: NativeStreamStats = {
  codec: undefined,
  decoded: 0,
  height: 0,
  resyncs: 0,
  width: 0,
};
