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
}
