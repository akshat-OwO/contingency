import { AgentSessionId } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AndroidLiveStream } from "@/components/agent/android-live-stream";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";
import { WorkspaceRefreshClockContext } from "@/lib/workspace-refresh";

const androidStreamAccess = () =>
  Effect.succeed({ path: "/android/stream/agent-one", token: "token" });

/** A keyframe whose payload carries an Annex-B SPS, as the worker sends it. */
const keyframe = { data: "AAAAAWdCQB4=", key: true };
const delta = { data: "AAAAAUE=", key: false };
const line = (frame: { data: string; key: boolean }) =>
  `${JSON.stringify({
    _tag: "frame",
    data: frame.data,
    height: 100,
    key: frame.key,
    timestamp: 1,
    width: 50,
  })}\n`;

/** The part of a decoded frame the viewer reads. */
interface FakeFrame {
  readonly close: () => void;
  readonly displayHeight: number;
  readonly displayWidth: number;
}

let decoders: FakeDecoder[] = [];

class FakeDecoder {
  decodeQueueSize = 0;
  readonly decoded: string[] = [];
  readonly init: { readonly output: (frame: FakeFrame) => void };
  resets = 0;
  state: CodecState = "unconfigured";

  constructor(init: { readonly output: (frame: FakeFrame) => void }) {
    this.init = init;
    decoders.push(this);
  }

  close() {
    this.state = "closed";
  }

  configure() {
    this.state = "configured";
  }

  decode(chunk: { readonly type: string }) {
    this.decoded.push(chunk.type);
    this.init.output({
      close: () => null,
      displayHeight: 100,
      displayWidth: 50,
    });
  }

  reset() {
    this.resets += 1;
    this.state = "unconfigured";
  }
}

/** One controller per fetched connection, in order. */
let connections: ReadableStreamDefaultController<Uint8Array>[] = [];
let fetchStream: ReturnType<typeof vi.fn>;
let clock: TestClock.TestClock;
let clockScope: Scope.Closeable;
const encoder = new TextEncoder();
const jsdomContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext"
) ?? { configurable: true, value: undefined };

beforeEach(async () => {
  decoders = [];
  connections = [];
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  // Called with `new`; returning an object makes that object the chunk.
  vi.stubGlobal(
    "EncodedVideoChunk",
    // oxlint-disable-next-line eslint/prefer-arrow-callback -- The viewer constructs chunks with `new`, which an arrow function cannot serve.
    vi.fn(function chunk(init: { readonly type: string }) {
      return { type: init.type };
    })
  );
  // jsdom has no 2D canvas; the viewer only clears and draws on it.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ clearRect: () => null, drawImage: () => null }),
  });
  fetchStream = vi.fn(() =>
    Promise.resolve({
      body: new ReadableStream<Uint8Array>({
        start: (controller) => {
          connections.push(controller);
        },
      }),
      ok: true,
    })
  );
  vi.stubGlobal("fetch", fetchStream);
  clockScope = await Effect.runPromise(Scope.make());
  clock = await Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, clockScope))
  );
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(
    HTMLCanvasElement.prototype,
    "getContext",
    jsdomContext
  );
  await Effect.runPromise(Scope.close(clockScope, Exit.void));
});

const show = () =>
  render(
    <RpcDependenciesProvider overrides={{ androidStreamAccess }}>
      <WorkspaceRefreshClockContext value={clock}>
        <RegistryProvider>
          <AndroidLiveStream sessionId={AgentSessionId.make("agent-one")} />
        </RegistryProvider>
      </WorkspaceRefreshClockContext>
    </RpcDependenciesProvider>
  );

const send = (connection: number, text: string) =>
  act(() => {
    connections[connection]?.enqueue(encoder.encode(text));
  });

const status = () => screen.getByRole("status").textContent;

it("drops a decode backlog and resumes at the next keyframe without losing the stream", async () => {
  show();
  await waitFor(() => expect(connections).toHaveLength(1));
  await send(0, line(keyframe));
  await waitFor(() => expect(status()).toBe("Live device display"));
  const [decoder] = decoders;
  // A tab that stalled receives a burst: the decoder is behind.
  decoder.decodeQueueSize = 9;
  await send(0, line(delta) + line(delta));
  await waitFor(() => expect(decoder.resets).toBe(1));
  decoder.decodeQueueSize = 0;
  await send(0, line(keyframe));
  await waitFor(() => expect(decoder.decoded).toEqual(["key", "key"]));
  expect(status()).toBe("Live device display");
  expect(fetchStream).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Reconnect device stream" })
  ).toBeNull();
});

it("reconnects on its own when a live stream ends", async () => {
  show();
  await waitFor(() => expect(connections).toHaveLength(1));
  await send(0, line(keyframe));
  await waitFor(() => expect(status()).toBe("Live device display"));
  await act(() => {
    connections[0]?.close();
  });
  await waitFor(() => expect(connections).toHaveLength(2));
  expect(status()).toBe("Device stream interrupted. Reconnecting…");
  await send(1, line(keyframe));
  await waitFor(() => expect(status()).toBe("Live device display"));
});

it("reconnects when the server reports the stream lost", async () => {
  show();
  await waitFor(() => expect(connections).toHaveLength(1));
  await send(0, line(keyframe));
  await waitFor(() => expect(status()).toBe("Live device display"));
  await send(0, `${JSON.stringify({ _tag: "state", state: "lost" })}\n`);
  await waitFor(() => expect(connections).toHaveLength(2));
  await send(1, line(keyframe));
  await waitFor(() => expect(status()).toBe("Live device display"));
});

it("stops after repeated failed connections and offers a manual reconnect", async () => {
  fetchStream.mockImplementation(() =>
    Promise.resolve({ body: null, ok: false })
  );
  show();
  const button = await waitFor(async () => {
    // Each pass releases the backoff the viewer is sleeping on, if any.
    await act(() =>
      Effect.runPromise(
        clock.adjust("4 seconds").pipe(Effect.timeout("30 seconds"))
      )
    );
    return screen.getByRole("button", { name: "Reconnect device stream" });
  });
  expect(status()).toBe("Device stream lost.");
  expect(fetchStream).toHaveBeenCalledTimes(5);
  await userEvent.click(button);
  // A fresh round: the manual attempt, then the immediate reconnect, which
  // waits on the backoff the test clock never releases.
  await waitFor(() => expect(fetchStream).toHaveBeenCalledTimes(7));
});
