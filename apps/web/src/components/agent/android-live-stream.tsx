import { AndroidStreamPacket } from "@contingency/protocol";
import type { AgentSessionId, NativeInput } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Clock, Duration, Effect, Fiber, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { decodeBase64 } from "@/lib/base64";
import { useRpcDependencies } from "@/lib/rpc-dependencies";
import { cn } from "@/lib/utils";
import { useWorkspaceRefreshClock } from "@/lib/workspace-refresh";

import type { AndroidStreamFrame } from "./android-stream-point";
import {
  makeFirstResponseProbe,
  probeNativeInput,
} from "./first-response-probe";
import { makeNativeInputHandlers } from "./native-input";

const packet = Schema.decodeUnknownSync(
  Schema.fromJsonString(AndroidStreamPacket)
);
type StreamState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "secure"
  | "lost"
  | "unsupported";
const labels: Record<StreamState, string> = {
  connecting: "Connecting to selected device…",
  live: "Live device display",
  lost: "Device stream lost.",
  reconnecting: "Device stream interrupted. Reconnecting…",
  secure: "Secure window, not visible",
  unsupported: "This browser cannot decode the live device stream.",
};

/** Frames waiting to decode before the viewer drops them for a keyframe. */
const DECODE_BACKLOG = 8;
/** Consecutive connections that end without a frame before the viewer stops. */
const RECONNECT_ATTEMPTS = 5;
/** The first reconnect is immediate; later ones back off up to 4 seconds. */
const reconnectDelay = (failures: number) =>
  Duration.millis(
    failures <= 1 ? 0 : Math.min(500 * 2 ** (failures - 2), 4000)
  );

/** The codec string an Annex-B keyframe's SPS advertises, if it has one. */
const h264Codec = (data: Uint8Array) => {
  // The SPS carries the actual encoder profile and level.
  const sps = data.findIndex(
    (byte, index) =>
      // oxlint-disable-next-line eslint/no-bitwise -- H.264 NAL unit type.
      (byte & 31) === 7 &&
      index >= 3 &&
      data[index - 1] === 1 &&
      data[index - 2] === 0 &&
      data[index - 3] === 0
  );
  return sps === -1 || sps + 3 >= data.length
    ? undefined
    : `avc1.${Array.from(data.slice(sps + 1, sps + 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * The live display fills its parent edge to edge and draws nothing over the
 * device's own pixels. While the user controls the session, what they do on
 * it is Forwarded Input: it goes straight to the device, and the server
 * attributes it to an element afterwards. The stream itself is never
 * Teaching evidence.
 *
 * A dropped connection reconnects on its own. A tab that stalls (for example
 * under memory pressure) receives a burst of frames when it resumes; the
 * viewer drops that backlog and rejoins at the next keyframe.
 */
export const AndroidLiveStream = ({
  dimmed = false,
  onFrame,
  onInput,
  sessionId,
}: {
  readonly dimmed?: boolean;
  /** Reports the decoded frame size whenever it changes. */
  readonly onFrame?: (frame: AndroidStreamFrame) => void;
  /** Forwards the user's input, or undefined while they cannot act. */
  readonly onInput?: ((input: NativeInput) => void) | undefined;
  readonly sessionId: AgentSessionId;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [probe] = useState(() =>
    makeFirstResponseProbe("android", () => canvas.current)
  );
  // The handlers outlive renders; they read the latest callback.
  const forward = useRef(onInput);
  useEffect(() => {
    forward.current = onInput;
  }, [onInput]);
  const clock = useWorkspaceRefreshClock();
  const { androidStreamAccess } = useRpcDependencies();
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
    /** One connection; it ends with an error when the stream is lost. */
    const connect = (waiting: StreamState, shown: () => void) =>
      Effect.scoped(
        Effect.gen(function* showDeviceStream() {
          const access = yield* androidStreamAccess(sessionId);
          yield* Effect.tryPromise({
            catch: (cause) =>
              cause instanceof Error ? cause : new Error("Device stream lost"),
            try: async (signal) => {
              let visible = false;
              let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
              let decoderFailed = false;
              const decoder = new VideoDecoder({
                error: () => {
                  // End this connection; the next one starts a fresh decoder.
                  decoderFailed = true;
                  void reader?.cancel().catch(() => {
                    // The connection may already have ended.
                  });
                },
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
                  probe.frame();
                  shown();
                  setState("live");
                },
              });
              setState(waiting);
              try {
                const response = await fetch(access.path, {
                  cache: "no-store",
                  headers: { Authorization: `Bearer ${access.token}` },
                  signal,
                });
                if (!response.ok || !response.body) {
                  throw new Error("Device stream unavailable");
                }
                const body = response.body.getReader();
                reader = body;
                const nextChunk = async () => {
                  const chunk = await body.read();
                  // A failed decoder cancels the read, which then reports done.
                  if (chunk.done || decoderFailed) {
                    throw new Error(
                      decoderFailed
                        ? "Device decoder failed"
                        : "Device stream ended"
                    );
                  }
                  return chunk.value;
                };
                const text = new TextDecoder();
                let pending = "";
                let configured = false;
                while (!signal.aborted) {
                  // Each read consumes the preceding chunk of the same byte stream.
                  // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop
                  const chunk = await nextChunk();
                  pending += text.decode(chunk, { stream: true });
                  if (pending.length > 4 * 1024 * 1024) {
                    throw new Error("Device stream exceeds limit");
                  }
                  let newline = pending.indexOf("\n");
                  while (newline !== -1) {
                    const event = packet(pending.slice(0, newline));
                    pending = pending.slice(newline + 1);
                    newline = pending.indexOf("\n");
                    if (event._tag === "state") {
                      if (event.state === "lost") {
                        throw new Error("Device stream lost");
                      }
                      visible = false;
                      context.clearRect(0, 0, surface.width, surface.height);
                      setState(
                        event.state === "connecting" ? waiting : "secure"
                      );
                      if (decoder.state === "configured") {
                        decoder.reset();
                      }
                      configured = false;
                      continue;
                    }
                    if (
                      configured &&
                      decoder.decodeQueueSize > DECODE_BACKLOG
                    ) {
                      // The decoder fell behind. Dropping deltas would corrupt
                      // the picture, so keep the last frame on screen and
                      // resume at the next keyframe.
                      decoder.reset();
                      configured = false;
                    }
                    const data = decodeBase64(event.data);
                    if (!configured) {
                      if (!event.key) {
                        continue;
                      }
                      const codec = h264Codec(data);
                      if (codec === undefined) {
                        throw new Error("Missing H.264 configuration");
                      }
                      decoder.configure({ codec, optimizeForLatency: true });
                      configured = true;
                      visible = true;
                    }
                    if (visible && decoder.state === "configured") {
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
      );
    const fiber = Effect.runFork(
      Effect.gen(function* followDeviceStream() {
        // Counts connections in a row that ended before showing a frame.
        let failures = 0;
        while (failures < RECONNECT_ATTEMPTS) {
          let shown = false;
          // Each connection ends before the next one starts.
          yield* connect(failures === 0 ? "connecting" : "reconnecting", () => {
            shown = true;
          }).pipe(Effect.ignore);
          failures = shown ? 1 : failures + 1;
          if (failures < RECONNECT_ATTEMPTS) {
            setState("reconnecting");
            yield* Effect.sleep(reconnectDelay(failures));
          }
        }
        setState("lost");
      }).pipe(Effect.provideService(Clock.Clock, clock))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [androidStreamAccess, clock, probe, sessionId, retry, setState]);
  const live = state === "live";
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);
  const [handlers] = useState(() =>
    makeNativeInputHandlers(
      (input) => forward.current?.(input),
      () => liveRef.current && forward.current !== undefined,
      probeNativeInput(probe)
    )
  );
  const interactive = live && onInput !== undefined;
  return (
    <div className="absolute inset-0 bg-neutral-950">
      <canvas
        aria-label={
          interactive
            ? "Selected device live display. Pointer, wheel, and keyboard input go to the device."
            : "Selected device live display"
        }
        aria-roledescription={interactive ? "device display" : undefined}
        className={cn(
          "size-full touch-none outline-none",
          live ? "" : "invisible",
          interactive ? "cursor-pointer" : "cursor-default",
          dimmed && "opacity-40 grayscale"
        )}
        {...handlers}
        ref={canvas}
        role={interactive ? "application" : "img"}
        tabIndex={interactive ? 0 : -1}
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
