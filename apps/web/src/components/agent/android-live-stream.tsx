import { AndroidStreamPacket } from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { useAtom } from "@effect/atom-react";
import { Effect, Fiber, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { androidStreamAccess } from "@/lib/rpc";

const packet = Schema.decodeUnknownSync(
  Schema.fromJsonString(AndroidStreamPacket)
);
type StreamState = "connecting" | "live" | "secure" | "lost" | "unsupported";
const labels: Record<StreamState, string> = {
  connecting: "Connecting to selected device…",
  live: "Live device display",
  lost: "Device stream lost. Semantic controls remain available.",
  secure: "Secure window, not visible",
  unsupported: "This browser cannot decode the live device stream.",
};

/** The live display has no input listeners and is never used as Teaching evidence. */
export const AndroidLiveStream = ({
  sessionId,
}: {
  readonly sessionId: AgentSessionId;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [stateAtom] = useState(() => Atom.make<StreamState>("connecting"));
  const [retryAtom] = useState(() => Atom.make(0));
  const [state, setState] = useAtom(stateAtom);
  const [retry, setRetry] = useAtom(retryAtom);
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
                  surface.width = frame.displayWidth;
                  surface.height = frame.displayHeight;
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
  return (
    <div className="grid gap-2">
      <p role="status" className="text-muted-foreground text-sm">
        {labels[state]}
      </p>
      <div className="grid min-h-64 place-items-center rounded-xl border bg-black p-2">
        <canvas
          ref={canvas}
          aria-label="Selected device live display"
          role="img"
          className={`max-h-[65vh] max-w-full object-contain ${state === "live" ? "" : "invisible"}`}
        />
      </div>
      {state === "lost" ? (
        <Button
          variant="outline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Reconnect device stream
        </Button>
      ) : null}
    </div>
  );
};
