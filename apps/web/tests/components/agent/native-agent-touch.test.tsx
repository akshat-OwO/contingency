import { AgentSessionId } from "@contingency/protocol";
import type { NativeAgentTouch as AgentTouch } from "@contingency/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { NativeAgentTouch } from "@/components/agent/native-agent-touch";
import type { runNativeAgentTouchStream } from "@/lib/rpc";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

const sessionId = AgentSessionId.make("agent-session-touch");
const frame = { height: 2400, width: 1080 };
const NOW = 1_763_456_000_000;
/** Web Animations the stage started: the dot's dip and its ring, per landing. */
let pulses = 0;

/** The subscriptions the stage opened, each with the sink it reads. */
let subscriptions: {
  readonly sessionId: AgentSessionId;
  readonly onTouch: (touch: AgentTouch) => Effect.Effect<void>;
  ended: boolean;
}[] = [];

const runStream: typeof runNativeAgentTouchStream = (id, onTouch) => {
  const subscription = { ended: false, onTouch, sessionId: id };
  subscriptions.push(subscription);
  return Effect.never.pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        subscription.ended = true;
      })
    )
  );
};

type Tap = Extract<AgentTouch, { readonly action: "tap" }>;
const touch = (fields: Partial<Tap> = {}): AgentTouch => ({
  action: "tap",
  durationMs: 0,
  screen: frame,
  timestamp: Date.now(),
  type: "agent_touch",
  x: 540,
  y: 1200,
  ...fields,
});

/** Delivers a touch as the server's stream would. */
const send = (next: AgentTouch) =>
  act(() => {
    const subscription = subscriptions.at(-1);
    if (subscription === undefined) {
      throw new Error("The stage never subscribed");
    }
    Effect.runSync(subscription.onTouch(next));
  });

/** Moves virtual time, running the animation frames that fall due. */
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const renderTouch = (
  props: Partial<Parameters<typeof NativeAgentTouch>[0]> = {}
) =>
  render(
    <RpcDependenciesProvider
      overrides={{ runNativeAgentTouchStream: runStream }}
    >
      <NativeAgentTouch
        frame={frame}
        sessionId={sessionId}
        visible
        {...props}
      />
    </RpcDependenciesProvider>
  );

const position = () => {
  const { style } = screen.getByTestId("agent-cursor");
  return { left: style.left, top: style.top };
};

beforeEach(() => {
  subscriptions = [];
  // Animation frames and `Date.now` run on virtual time.
  vi.useFakeTimers({ now: NOW });
  // jsdom has no Web Animations; the landing pulse is only counted.
  pulses = 0;
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: () => {
      pulses += 1;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

it("subscribes to the session's touches and draws nothing before one", () => {
  renderTouch();
  expect(subscriptions.map((entry) => entry.sessionId)).toEqual([sessionId]);
  const cursor = screen.getByTestId("agent-cursor");
  expect(cursor).toHaveClass("opacity-0");
  expect(cursor.closest("[aria-hidden='true']")).not.toBeNull();
  expect(cursor).toHaveTextContent("Agent");
});

it("lands the agent's tap at its share of the frame", () => {
  renderTouch();
  send(touch());
  advance(16);
  expect(position()).toEqual({ left: "50%", top: "50%" });
  expect(screen.getByTestId("agent-cursor")).toHaveClass("opacity-100");
  expect(pulses).toBe(2);
});

it("travels from the last touch to the next over its duration", () => {
  renderTouch();
  send(touch());
  advance(16);
  send(touch({ durationMs: 300, x: 108, y: 240 }));
  advance(120);
  // Partway: neither where it left nor where it is going.
  expect(position()).not.toEqual({ left: "50%", top: "50%" });
  expect(position()).not.toEqual({ left: "10%", top: "10%" });
  advance(300);
  expect(position()).toEqual({ left: "10%", top: "10%" });
});

it("follows a swipe to where it ends", () => {
  renderTouch();
  send({
    ...touch(),
    action: "swipe",
    end: { x: 540, y: 480 },
    x: 540,
    y: 1920,
  });
  advance(16);
  expect(position().top).not.toBe("20%");
  advance(1000);
  expect(position()).toEqual({ left: "50%", top: "20%" });
  expect(screen.getByTestId("agent-cursor")).toHaveAttribute(
    "data-action",
    "swipe"
  );
});

it("places a replayed touch without replaying its stroke", () => {
  renderTouch();
  send(touch({ durationMs: 400, timestamp: NOW - 5000, x: 270, y: 600 }));
  // No animation frame has run: the stale touch is placed at once.
  expect(position()).toEqual({ left: "25%", top: "25%" });
  expect(pulses).toBe(0);
});

it("places the touch without motion when motion is reduced", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  renderTouch();
  send(touch({ durationMs: 400, x: 270, y: 600 }));
  expect(position()).toEqual({ left: "25%", top: "25%" });
});

it("hides the touch while the user holds the device", () => {
  renderTouch({ visible: false });
  send(touch());
  advance(16);
  expect(screen.getByTestId("agent-cursor")).toHaveClass("opacity-0");
});

it("hides a touch measured on a screen turned against the frame", () => {
  renderTouch({ frame: { height: 1080, width: 2400 } });
  send(touch());
  advance(16);
  expect(screen.getByTestId("agent-cursor")).toHaveClass("opacity-0");
});

it("forgets one session's touch and subscription when the stage moves on", () => {
  const { rerender, unmount } = renderTouch();
  send(touch());
  advance(16);
  const other = AgentSessionId.make("agent-session-other");
  rerender(
    <RpcDependenciesProvider
      overrides={{ runNativeAgentTouchStream: runStream }}
    >
      <NativeAgentTouch frame={frame} sessionId={other} visible />
    </RpcDependenciesProvider>
  );
  expect(subscriptions.map((entry) => entry.ended)).toEqual([true, false]);
  expect(screen.getByTestId("agent-cursor")).toHaveClass("opacity-0");
  unmount();
  expect(subscriptions.at(-1)?.ended).toBe(true);
});
