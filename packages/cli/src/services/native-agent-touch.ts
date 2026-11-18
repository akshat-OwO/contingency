import type { AgentSessionId, NativeAgentTouch } from "@contingency/protocol";
import { agentPointerTravelMs } from "@contingency/protocol";
import {
  Clock,
  Context,
  Effect,
  Layer,
  PubSub,
  Semaphore,
  Stream,
} from "effect";

/**
 * How long a touch waits after it lands before the device acts, so the press
 * is seen to land before the app answers it. The browser's click lead.
 */
export const TOUCH_LEAD_MS = 40;

/**
 * The width, in pixels, that `agentPointerTravelMs` is tuned for. A device
 * screen is measured in device pixels, two or three times as many as the CSS
 * pixels of a browser viewport of the same size, so a reach is scaled to this
 * width before it is timed and a phone's touch travels as a Page cursor does.
 */
const TRAVEL_REFERENCE_WIDTH = 400;

/** One gesture the agent is about to make, in the observation's pixels. */
export type NativeAgentGesture =
  | {
      readonly action: "tap" | "press";
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly action: "swipe";
      readonly x: number;
      readonly y: number;
      readonly end: { readonly x: number; readonly y: number };
    };

export interface NativeAgentTouchesService {
  /**
   * Publishes the agent's next touch on a native session and waits until it
   * has been drawn arriving, so a watcher sees where the agent reaches before
   * the app reacts. Only the agent's own gestures call this; Forwarded Input
   * never does (ADR 0076).
   */
  readonly touch: (
    sessionId: AgentSessionId,
    gesture: NativeAgentGesture,
    screen: { readonly width: number; readonly height: number }
  ) => Effect.Effect<void>;
  /** The session's touches, replaying the latest one to a new subscriber. */
  readonly stream: (
    sessionId: AgentSessionId
  ) => Stream.Stream<NativeAgentTouch>;
  /** Ends a closed session's stream and forgets where its touch rests. */
  readonly release: (sessionId: AgentSessionId) => Effect.Effect<void>;
}

export const NativeAgentTouches = Context.Service<NativeAgentTouchesService>(
  "@contingency/NativeAgentTouches"
);

interface Hub {
  readonly pubsub: PubSub.PubSub<NativeAgentTouch>;
  last: { readonly x: number; readonly y: number } | undefined;
}

/** How long a touch takes to travel from where the last one rested. */
export const nativeTouchTravelMs = (
  from: { readonly x: number; readonly y: number } | undefined,
  to: { readonly x: number; readonly y: number },
  screenWidth: number
): number =>
  from === undefined
    ? 0
    : agentPointerTravelMs(
        (Math.hypot(to.x - from.x, to.y - from.y) * TRAVEL_REFERENCE_WIDTH) /
          screenWidth
      );

export const makeNativeAgentTouches = Effect.gen(
  function* makeNativeAgentTouches() {
    const hubs = new Map<AgentSessionId, Hub>();
    // A closed session never touches again, and a stage that subscribes
    // after it closed gets an ended stream rather than a hub nobody releases.
    const released = new Set<AgentSessionId>();
    const lock = yield* Semaphore.make(1);
    const hubFor = (sessionId: AgentSessionId) =>
      lock.withPermit(
        Effect.gen(function* openHub() {
          const existing = hubs.get(sessionId);
          if (existing !== undefined || released.has(sessionId)) {
            return existing;
          }
          const hub: Hub = {
            last: undefined,
            pubsub: yield* PubSub.sliding<NativeAgentTouch>({
              capacity: 8,
              replay: 1,
            }),
          };
          hubs.set(sessionId, hub);
          return hub;
        })
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(hubs.values(), (hub) => PubSub.shutdown(hub.pubsub), {
        discard: true,
      })
    );
    return NativeAgentTouches.of({
      release: (sessionId) =>
        lock.withPermit(
          Effect.suspend(() => {
            const hub = hubs.get(sessionId);
            hubs.delete(sessionId);
            released.add(sessionId);
            return hub === undefined
              ? Effect.void
              : PubSub.shutdown(hub.pubsub);
          })
        ),
      stream: (sessionId) =>
        Stream.unwrap(
          Effect.map(hubFor(sessionId), (hub) =>
            hub === undefined ? Stream.empty : Stream.fromPubSub(hub.pubsub)
          )
        ),
      touch: (sessionId, gesture, screen) =>
        Effect.gen(function* publishTouch() {
          const hub = yield* hubFor(sessionId);
          if (hub === undefined) {
            return;
          }
          const width = Math.max(1, Math.round(screen.width));
          const height = Math.max(1, Math.round(screen.height));
          const durationMs = nativeTouchTravelMs(hub.last, gesture, width);
          hub.last =
            gesture.action === "swipe"
              ? gesture.end
              : { x: gesture.x, y: gesture.y };
          const timestamp = yield* Clock.currentTimeMillis;
          // `publish` applies the sliding strategy; `publishUnsafe` would drop
          // the newest touch once a stalled subscriber fills the ring.
          const touch: NativeAgentTouch = {
            ...gesture,
            durationMs,
            screen: { height, width },
            timestamp,
            type: "agent_touch",
          };
          yield* PubSub.publish(hub.pubsub, touch);
          // The gesture waits for its touch, as a browser click waits for its
          // cursor, so the agent is seen to reach before the app reacts.
          yield* Effect.sleep(durationMs + TOUCH_LEAD_MS);
        }),
    });
  }
);

/** One per process, shared by the Android and iOS Workspaces and the RPC. */
export const NativeAgentTouchesLive = Layer.effect(
  NativeAgentTouches,
  makeNativeAgentTouches
);
