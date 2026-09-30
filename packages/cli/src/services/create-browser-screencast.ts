import { randomUUID } from "node:crypto";

import {
  BrowserStreamId,
  FrameSequence as FrameSequenceSchema,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  BrowserStreamId as BrowserStreamIdType,
  FrameSequence,
} from "@contingency/protocol";
import { Context, Effect, PubSub, Ref, Result } from "effect";

import {
  decodeScreencastFrame,
  emitStatus,
  publishTabs,
  readSessionState,
  tryBrowser,
} from "./create-browser-session.ts";
import type {
  BrowserFrame,
  CreateSession,
  Screencast,
} from "./create-browser-session.ts";

/** Internal capture policy, overridden by the repeatable streaming benchmark. */
export class ScreencastOptions extends Context.Service<
  ScreencastOptions,
  {
    readonly format: "jpeg" | "png";
    readonly quality: number;
    readonly maxPixelRatio: number;
  }
>()("contingency/ScreencastOptions") {}

export const defaultScreencastOptions: ScreencastOptions["Service"] = {
  format: "jpeg",
  maxPixelRatio: 2,
  quality: 90,
};

const stopUnlocked = (session: CreateSession) =>
  Effect.gen(function* stopCurrentScreencast() {
    const current = yield* Ref.modify(session.state, (state) => [
      state.screencast,
      { ...state, screencast: undefined },
    ]);
    if (current === undefined) {
      return;
    }
    yield* tryBrowser("Could not stop the canvas stream", async () => {
      await current.cdp.send("Page.stopScreencast").catch(() => null);
      await current.cdp.detach().catch(() => null);
    }).pipe(Effect.ignore);
  });

const startUnlocked = (session: CreateSession) =>
  Effect.gen(function* startCanvasScreencast() {
    const initialState = yield* Ref.get(session.state);
    if (
      initialState.screencast !== undefined ||
      initialState.streamSubscribers === 0
    ) {
      return;
    }
    const cdp = yield* tryBrowser("Could not open the canvas stream", () =>
      session.context.newCDPSession(initialState.activePage)
    );
    const screencast: Screencast = {
      cdp,
      streamId: BrowserStreamId.make(randomUUID()),
    };
    yield* Ref.update(session.state, (state) => ({
      ...state,
      lastStreamId: screencast.streamId,
      screencast,
    }));
    cdp.on("Page.screencastFrame", (raw) => {
      const receivedAt = Date.now();
      if (
        readSessionState(session).screencast?.streamId !== screencast.streamId
      ) {
        return;
      }
      const frame = decodeScreencastFrame(raw);
      if (frame === undefined) {
        const { viewport } = readSessionState(session);
        PubSub.publishUnsafe(session.events, {
          connected: false,
          screencasting: false,
          type: "status",
          viewportHeight: viewport.height,
          viewportWidth: viewport.width,
        });
        Effect.runFork(
          session.screencastLock.withPermit(
            Effect.gen(function* stopInvalidScreencast() {
              const { screencast: current } = yield* Ref.get(session.state);
              if (current?.streamId === screencast.streamId) {
                yield* stopUnlocked(session);
              }
            })
          )
        );
        return;
      }
      const sequence = Effect.runSync(
        Ref.modify(session.state, (state) => {
          const current = state.screencast;
          if (current?.streamId !== screencast.streamId) {
            return [undefined, state];
          }
          return [
            state.sequence,
            {
              ...state,
              sequence: state.sequence + 1,
            },
          ];
        })
      );
      if (sequence === undefined) {
        return;
      }
      Effect.runSync(
        PubSub.publish<BrowserFrame>(session.frames, {
          data: Buffer.from(frame.data, "base64"),
          metadata: {
            deviceHeight: Math.trunc(frame.metadata.deviceHeight),
            deviceWidth: Math.trunc(frame.metadata.deviceWidth),
            offsetTop: frame.metadata.offsetTop,
            pageScaleFactor: frame.metadata.pageScaleFactor,
            scrollOffsetX: frame.metadata.scrollOffsetX,
            scrollOffsetY: frame.metadata.scrollOffsetY,
            timestamp: frame.metadata.timestamp ?? Date.now() / 1000,
          },
          receivedAt,
          seq: FrameSequenceSchema.make(sequence),
          streamId: screencast.streamId,
          type: "frame",
        })
      );
      // Capture owns Chromium's credits. Slow viewers retain only the latest
      // frame and cannot stall the browser or the Teaching recorder.
      Effect.runFork(
        Effect.gen(function* acknowledgeCapturedFrame() {
          const outcome = yield* Effect.result(
            tryBrowser("Could not acknowledge the captured frame", () =>
              cdp.send("Page.screencastFrameAck", {
                sessionId: frame.sessionId,
              })
            ).pipe(Effect.retry({ times: 2 }))
          );
          if (Result.isSuccess(outcome)) {
            return;
          }
          yield* session.screencastLock.withPermit(
            Effect.gen(function* stopFailedCapture() {
              if (
                readSessionState(session).screencast?.streamId !==
                screencast.streamId
              ) {
                return;
              }
              yield* Effect.logWarning(outcome.failure.message);
              yield* stopUnlocked(session);
              emitStatus(session, false);
            })
          );
        })
      );
    });
    const { viewport } = yield* Ref.get(session.state);
    const options = yield* Effect.serviceOption(ScreencastOptions).pipe(
      Effect.map((value) =>
        value._tag === "Some" ? value.value : defaultScreencastOptions
      )
    );
    const pixelRatio = Math.min(
      viewport.deviceScaleFactor,
      options.maxPixelRatio
    );
    const started = yield* Effect.result(
      tryBrowser("Could not start the canvas stream", () =>
        cdp.send("Page.startScreencast", {
          format: options.format,
          maxHeight: Math.round(viewport.height * pixelRatio),
          maxWidth: Math.round(viewport.width * pixelRatio),
          quality: options.quality,
        })
      )
    );
    if (Result.isFailure(started)) {
      yield* stopUnlocked(session);
      return yield* Effect.fail(started.failure);
    }
    emitStatus(session, true);
    publishTabs(session);
    const state = yield* Ref.get(session.state);
    const tabId = state.pageIds.get(state.activePage);
    if (tabId === undefined) {
      return yield* Effect.fail(
        makeBrowserRpcError(
          "stream_failed",
          "The active Page disappeared before streaming started."
        )
      );
    }
    PubSub.publishUnsafe(session.events, {
      tabId,
      timestamp: Date.now(),
      type: "url",
      url: state.activePage.url(),
    });
  });

export const stopScreencast = (session: CreateSession) =>
  session.screencastLock.withPermit(stopUnlocked(session));

export const startScreencast = (session: CreateSession) =>
  Effect.acquireRelease(
    session.screencastLock.withPermit(
      Effect.gen(function* subscribeCapture() {
        yield* Ref.update(session.state, (state) => ({
          ...state,
          streamSubscribers: state.streamSubscribers + 1,
        }));
        const started = yield* Effect.result(startUnlocked(session));
        if (Result.isFailure(started)) {
          yield* Ref.update(session.state, (state) => ({
            ...state,
            streamSubscribers: state.streamSubscribers - 1,
          }));
          return yield* Effect.fail(started.failure);
        }
      })
    ),
    () =>
      session.screencastLock.withPermit(
        Effect.gen(function* unsubscribeCapture() {
          const subscribers = yield* Ref.modify(session.state, (state) => [
            state.streamSubscribers - 1,
            { ...state, streamSubscribers: state.streamSubscribers - 1 },
          ]);
          if (subscribers === 0) {
            yield* stopUnlocked(session);
          }
        })
      )
  );

export const restartScreencast = (session: CreateSession) =>
  session.screencastLock.withPermit(
    stopUnlocked(session).pipe(Effect.andThen(startUnlocked(session)))
  );

export const acknowledgeFrame = (
  session: CreateSession,
  _sequence: FrameSequence,
  streamId: BrowserStreamIdType
) =>
  Effect.suspend(() => {
    // Retain the public RPC for connected clients from an earlier UI build.
    // Capture already acknowledged this frame after bounded publication.
    if (readSessionState(session).lastStreamId !== streamId) {
      return Effect.fail(
        makeBrowserRpcError("stream_failed", "The canvas stream changed.")
      );
    }
    return Effect.void;
  });
