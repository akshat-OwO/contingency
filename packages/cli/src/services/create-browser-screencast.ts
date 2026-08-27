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
import { Effect, PubSub, Ref, Result } from "effect";

import {
  decodeScreencastFrame,
  emitStatus,
  publishTabs,
  readSessionState,
  tryBrowser,
} from "./create-browser-session.ts";
import type {
  CreateSession,
  CreateSessionState,
  FrameAcknowledgement,
  Screencast,
} from "./create-browser-session.ts";

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
    if (initialState.screencast !== undefined) {
      return;
    }
    const cdp = yield* tryBrowser("Could not open the canvas stream", () =>
      session.context.newCDPSession(initialState.activePage)
    );
    const screencast: Screencast = {
      cdp,
      pending: new Map(),
      streamId: BrowserStreamId.make(randomUUID()),
    };
    yield* Ref.update(session.state, (state) => ({ ...state, screencast }));
    cdp.on("Page.screencastFrame", (raw: unknown) => {
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
          const pending = new Map([
            ...current.pending,
            [state.sequence, frame.sessionId],
          ]);
          return [
            state.sequence,
            {
              ...state,
              screencast: { ...current, pending },
              sequence: state.sequence + 1,
            },
          ];
        })
      );
      if (sequence === undefined) {
        return;
      }
      PubSub.publishUnsafe(session.events, {
        data: frame.data,
        metadata: {
          deviceHeight: Math.trunc(frame.metadata.deviceHeight),
          deviceWidth: Math.trunc(frame.metadata.deviceWidth),
          offsetTop: frame.metadata.offsetTop,
          pageScaleFactor: frame.metadata.pageScaleFactor,
          scrollOffsetX: frame.metadata.scrollOffsetX,
          scrollOffsetY: frame.metadata.scrollOffsetY,
          timestamp: frame.metadata.timestamp ?? Date.now() / 1000,
        },
        seq: FrameSequenceSchema.make(sequence),
        streamId: screencast.streamId,
        type: "frame",
      });
    });
    const { viewport } = yield* Ref.get(session.state);
    const started = yield* Effect.result(
      tryBrowser("Could not start the canvas stream", () =>
        cdp.send("Page.startScreencast", {
          format: "jpeg",
          maxHeight: viewport.height,
          maxWidth: viewport.width,
          quality: 80,
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
  session.screencastLock.withPermit(startUnlocked(session));

export const restartScreencast = (session: CreateSession) =>
  session.screencastLock.withPermit(
    stopUnlocked(session).pipe(Effect.andThen(startUnlocked(session)))
  );

export const acknowledgeFrame = (
  session: CreateSession,
  sequence: FrameSequence,
  streamId: BrowserStreamIdType
) =>
  Effect.gen(function* acknowledgeCanvasFrame() {
    const acknowledgement = yield* Ref.modify(
      session.state,
      (state): readonly [FrameAcknowledgement, CreateSessionState] => {
        const { screencast } = state;
        if (screencast === undefined || screencast.streamId !== streamId) {
          return [{ _tag: "stream_changed" }, state];
        }
        const cdpSequence = screencast.pending.get(sequence);
        if (cdpSequence === undefined) {
          return [{ _tag: "frame_missing" }, state];
        }
        const pending = new Map(screencast.pending);
        pending.delete(sequence);
        return [
          { _tag: "acknowledge", cdp: screencast.cdp, cdpSequence },
          { ...state, screencast: { ...screencast, pending } },
        ];
      }
    );
    if (acknowledgement._tag === "stream_changed") {
      return yield* Effect.fail(
        makeBrowserRpcError("stream_failed", "The canvas stream changed.")
      );
    }
    if (acknowledgement._tag === "frame_missing") {
      return yield* Effect.fail(
        makeBrowserRpcError("stream_failed", "The frame is no longer pending.")
      );
    }
    yield* tryBrowser("Could not acknowledge the canvas frame", () =>
      acknowledgement.cdp.send("Page.screencastFrameAck", {
        sessionId: acknowledgement.cdpSequence,
      })
    );
  });
