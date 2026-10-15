import { AndroidStreamPacket } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { androidStreamAccess } from "@/lib/rpc";
import { cn } from "@/lib/utils";

import { framePoint } from "./android-stream-point";
import type {
  AndroidStreamFrame,
  AndroidStreamPoint,
} from "./android-stream-point";

const packet = Schema.decodeUnknownSync(
  Schema.fromJsonString(AndroidStreamPacket)
);
type StreamState = "connecting" | "live" | "secure" | "lost" | "unsupported";
const labels: Record<StreamState, string> = {
  connecting: "Connecting to selected device…",
  live: "Live device display",
  lost: "Device stream lost.",
  secure: "Secure window, not visible",
  unsupported: "This browser cannot decode the live device stream.",
};

/**
 * The live display fills its parent edge to edge and draws nothing over the
 * device's own pixels. A click is reported as where it landed on the frame;
 * the server resolves it to a semantic element, so the stream itself never
 * sends input and is never used as Teaching evidence.
 */
export const AndroidLiveStream = ({
  dimmed = false,
  onFrame,
  onPick,
  sessionId,
}: {
  readonly dimmed?: boolean;
  /** Reports the decoded frame size whenever it changes. */
  readonly onFrame?: (frame: AndroidStreamFrame) => void;
  readonly onPick?:
    | ((point: AndroidStreamPoint, frame: AndroidStreamFrame) => void)
    | undefined;
  readonly sessionId: AgentSessionId;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stateAtom] = useState(() => Atom.make<StreamState>("connecting"));
  const [retryAtom] = useState(() => Atom.make(0));
  const [state, setState] = useAtom(stateAtom);
  const [retry, setRetry] = useAtom(retryAtom);
  // The decoder outlives renders; it reads the latest callback, not the first.
  const reportFrame = useRef(onFrame);
  useEffect(() => {
    reportFrame.current = onFrame;
  }, [onFrame]);
  useEffect(() => {
    const surface = canvas.current;
    if (!surface || typeof VideoDecoder === "undefined") {
      setState("unsupported");
      return;
    }
    const context = surface.getContext("2d");
    if (!context) {
      setState("unsupported");
      return;
    }
    setState("connecting");
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* showDeviceStream() {
          const access = yield* androidStreamAccess(sessionId);
          yield* Effect.tryPromise({
            catch: () => new Error("Device stream lost"),
            try: async (signal) => {
              let visible = false;
              const decoder = new VideoDecoder({
                error: () => setState("lost"),
                output: (frame) => {
                  if (!visible || signal.aborted) {
                    frame.close();
                    return;
                  }
                  if (
                    surface.width !== frame.displayWidth ||
                    surface.height !== frame.displayHeight
                  ) {
                    surface.width = frame.displayWidth;
                    surface.height = frame.displayHeight;
                    reportFrame.current?.({
                      height: frame.displayHeight,
                      width: frame.displayWidth,
                    });
                  }
                  context.drawImage(frame, 0, 0);
                  frame.close();
                  setState("live");
                },
              });
              let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
              try {
                const response = await fetch(access.path, {
                  cache: "no-store",
                  headers: { Authorization: `Bearer ${access.token}` },
                  signal,
                });
                if (!response.ok || !response.body) {
                  throw new Error("Device stream unavailable");
                }
                reader = response.body.getReader();
                const text = new TextDecoder();
                let pending = "";
                let configured = false;
                while (!signal.aborted) {
                  // Each read consumes the preceding chunk of the same byte stream.
                  // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop
                  const chunk = await reader.read();
                  if (chunk.done) {
                    throw new Error("Device stream ended");
                  }
                  pending += text.decode(chunk.value, { stream: true });
                  if (pending.length > 4 * 1024 * 1024) {
                    throw new Error("Device stream exceeds limit");
                  }
                  let newline = pending.indexOf("\n");
                  while (newline !== -1) {
                    const event = packet(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                    newline = pending.indexOf("\n");
                    if (event._tag === "state") {
                      visible = false;
                      context.clearRect(0, 0, surface.width, surface.height);
                      setState(event.state);
                      if (decoder.state === "configured") {
                        decoder.reset();
                      }
                      configured = false;
                      continue;
                    }
                    const data = Uint8Array.from(
                      atob(event.data),
                      (character) => character.codePointAt(0) ?? 0
                    );
                    if (!configured) {
                      if (!event.key) {
                        continue;
                      }
                      // Annex-B SPS advertises the actual encoder profile and level.
                      const sps = data.findIndex(
                        (byte, index) =>
                          // oxlint-disable-next-line eslint/no-bitwise -- H.264 NAL unit type.
                          (byte & 31) === 7 &&
                          index >= 3 &&
                          data[index - 1] === 1 &&
                          data[index - 2] === 0 &&
                          data[index - 3] === 0
                      );
                      if (sps === -1 || sps + 3 >= data.length) {
                        throw new Error("Missing H.264 configuration");
                      }
                      const codec = `avc1.${Array.from(data.slice(sps + 1, sps + 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
                      decoder.configure({ codec, optimizeForLatency: true });
                      configured = true;
                      visible = true;
                    }
                    if (visible && decoder.state === "configured") {
                      if (decoder.decodeQueueSize > 8) {
                        throw new Error("Device decoder is too slow");
                      }
                      decoder.decode(
                        new EncodedVideoChunk({
                          data,
                          timestamp: event.timestamp,
                          type: event.key ? "key" : "delta",
                        })
                      );
                    }
                  }
                }
              } finally {
                await reader?.cancel().catch(() => {
                  // The connection may already have ended.
                });
                if (decoder.state !== "closed") {
                  decoder.close();
                }
                context.clearRect(0, 0, surface.width, surface.height);
              }
            },
          });
        })
      ).pipe(Effect.catchCause(() => Effect.sync(() => setState("lost"))))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [sessionId, retry, setState]);
  const live = state === "live";
  return (
    <div className="absolute inset-0 bg-neutral-950">
      <canvas
        aria-label="Selected device live display"
        className={cn(
          "size-full",
          live ? "" : "invisible",
          live && onPick !== undefined ? "cursor-pointer" : "cursor-default",
          dimmed && "opacity-40 grayscale"
        )}
        onClick={(event) => {
          const surface = canvas.current;
          if (!live || onPick === undefined || surface === null) {
            return;
          }
          const point = framePoint(event, surface.getBoundingClientRect());
          if (point !== null) {
            onPick(point, { height: surface.height, width: surface.width });
          }
        }}
        ref={canvas}
        role="img"
      />
      <div
        className={cn(
          "absolute inset-0 grid place-items-center p-8 text-center",
          live && "hidden"
        )}
      >
        <div className="space-y-3">
          <p className="text-sm text-neutral-400" role="status">
            {labels[state]}
          </p>
          {state === "lost" ? (
            <Button
              onClick={() => setRetry((value) => value + 1)}
              size="sm"
              variant="secondary"
            >
              Reconnect device stream
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
