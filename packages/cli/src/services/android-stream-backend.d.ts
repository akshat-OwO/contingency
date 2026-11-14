declare module "expo-device-hub/vendor/serve-emu/dist/scrcpy.js" {
  import type { ChildProcess } from "node:child_process";
  import type { Socket } from "node:net";

  export function startScrcpy(
    options: {
      serial: string;
      signal: AbortSignal;
      maxSize: number;
      maxFps: number;
      bitRate: number;
      keyFrameInterval: number;
      repeatFrameMs: number;
    },
    dependencies: {
      ensureServer: () => Promise<string>;
      randomScid: () => string;
    }
  ): Promise<{
    meta: { width: number; height: number; codecId: string };
    proc: ChildProcess;
    controlSocket: Socket;
    localPort: number;
    scid: string;
    readFrame: () => Promise<
      | { type: "session"; width: number; height: number }
      | {
          type: "frame";
          data: Uint8Array;
          pts: bigint;
          isConfig: boolean;
          isKey: boolean;
        }
      | null
    >;
    close: () => Promise<void>;
  }>;
  /** scrcpy started for control only; its owner closes it. */
  export interface ScrcpyControlSession {
    readonly proc: ChildProcess;
    readonly controlSocket: Socket;
    readonly close: () => Promise<void>;
  }
  /** Starts only scrcpy's control socket, for a stream whose video is elsewhere. */
  export function startScrcpyControl(
    options: { serial: string; signal: AbortSignal },
    dependencies: {
      ensureServer: () => Promise<string>;
      randomScid: () => string;
    }
  ): Promise<ScrcpyControlSession>;
}

declare module "expo-device-hub/vendor/serve-emu/dist/grpc-session.js" {
  import type { ScrcpyControlSession } from "expo-device-hub/vendor/serve-emu/dist/scrcpy.js";

  /** A gesture the stream's input queue accepts, in display fractions. */
  export type ServeEmuGesture =
    | {
        readonly type: "touch";
        readonly action: "down" | "move" | "up";
        readonly x: number;
        readonly y: number;
      }
    | {
        readonly type: "swipe";
        readonly x1: number;
        readonly y1: number;
        readonly x2: number;
        readonly y2: number;
        readonly durationMs: number;
      }
    | {
        readonly type: "key";
        readonly action: "down" | "up";
        readonly keycode: number;
        readonly metaState: number;
      }
    | { readonly type: "text"; readonly text: string };
  /** Settles once the gesture is sent, or rejects when it is dropped. */
  export interface GestureReceipt {
    readonly completion: Promise<void>;
  }

  /**
   * An emulator stream read from the emulator's own gRPC screen and encoded
   * on the host. Input goes through its gesture queue in display fractions.
   */
  export function startGrpcSession(
    options: {
      serial: string;
      signal: AbortSignal;
      grpcImageMode: "rgb888" | "mmap" | "png";
      inputSource: "scrcpy";
      encoder: "software" | "hardware";
      maxSize: number;
      maxFps: number;
      bitRate: number;
      keyFrameInterval: number;
      repeatFrameMs: number;
    },
    dependencies: {
      startScrcpyControl: (options: {
        serial: string;
        signal: AbortSignal;
      }) => Promise<ScrcpyControlSession>;
    }
  ): Promise<{
    meta: { width: number; height: number; codecId: string };
    controls: {
      enqueue: (
        gesture: ServeEmuGesture,
        screen: { width: number; height: number }
      ) => GestureReceipt;
    };
    readFrame: () => Promise<
      | { type: "session"; width: number; height: number }
      | {
          type: "frame";
          data: Uint8Array;
          pts: bigint;
          isConfig: boolean;
          isKey: boolean;
        }
      | null
    >;
    close: () => Promise<void>;
  }>;
}

declare module "expo-device-hub/vendor/serve-emu/dist/screen-recording.js" {
  /** One recording generation, written as fragmented MP4 into `directory`. */
  export class ScreenRecording {
    /** Creates `directory`, which must not exist yet, and its manifest. */
    static create(options: {
      directory: string;
      maxDurationMs?: number;
      maxFileBytes?: number | undefined;
      minFreeBytes?: number;
      maxQueuedBytes?: number;
      finalizeTimeoutMs?: number;
      clock?: { monotonicUs: () => bigint; epochMs: () => number };
    }): Promise<ScreenRecording>;
    /** Waiting for its first keyframe, or recording. */
    readonly active: boolean;
    snapshot():
      | { status: "waiting" | "finalizing" | "complete" }
      | {
          status: "recording";
          firstFrameAt: string;
          frames: number;
          queuedBytes: number;
        }
      | { status: "failed"; error: string };
    /**
     * Takes one H.264 access unit in Annex B form. A keyframe carries its
     * SPS and PPS. A failure is recorded in the snapshot, never thrown.
     */
    accept(
      packet:
        | { type: "session"; width: number; height: number }
        | {
            type: "frame";
            data: Uint8Array;
            pts: bigint;
            isConfig: boolean;
            isKey: boolean;
          },
      size: { width: number; height: number },
      source: string
    ): void;
    /** Finalizes `recording.mp4` in the directory. */
    finish(): Promise<{ directory: string }>;
    fail(reason: Error): void;
  }
}
