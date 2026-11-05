import { AgentSessionId, ContentHash } from "@contingency/protocol";
import type { DeviceKeyframes } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { afterEach, expect, test } from "vitest";

import {
  DeviceLastScreen,
  DeviceRunSummary,
} from "@/components/agent/android-run-summary";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

const session = {
  assessment: null,
  captureGaps: [],
  cleanup: null,
  error: null,
  id: AgentSessionId.make("agent-ios-ended"),
  kind: "teaching",
  takeoverOccurred: false,
} as const;

const summary = (keyframes: DeviceKeyframes | null | Error) =>
  render(
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () =>
          Atom.make(
            keyframes instanceof Error
              ? Effect.fail(keyframes)
              : Effect.succeed(keyframes)
          ),
      }}
    >
      <DeviceRunSummary
        device="iPhone 17 · iOS 26.5"
        platform="ios"
        session={session}
        targetApp="dev.contingency.login · build 1"
      />
    </RpcDependenciesProvider>
  );

const hash = (digit: string) => ContentHash.make(`sha256-${digit.repeat(64)}`);

test("an ended device session shows the screens it kept, in order", () => {
  summary({
    keyframes: [
      { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
      { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
    ],
    retained: true,
  });
  const screens = screen.getAllByRole("img");
  expect(screens).toHaveLength(2);
  expect(screens[0]).toHaveAttribute(
    "src",
    `/ios/sessions/agent-ios-ended/keyframes/${hash("a")}`
  );
  expect(screens[1]).toHaveAccessibleName("Screen 2 of 2, 0:05 in");
  // Teaching has no Agent Assessment, so the summary leads with its screens.
  expect(screen.queryByText("Agent Assessment")).toBeNull();
});

test("says what became of screens cleanup deleted", () => {
  summary({
    keyframes: [{ capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") }],
    retained: false,
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByText(/Cleanup deleted the one screen this session kept/u)
  ).toBeVisible();
});

test("tells a forgotten session from a failed read, which it can retry", () => {
  summary(null);
  expect(
    screen.getByText(/This Workspace no longer holds the session/u)
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  cleanup();
  summary(new Error("The keyframe list answered 500."));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The screens could not be read."
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

const stage = (keyframes: DeviceKeyframes) =>
  render(
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () => Atom.make(Effect.succeed(keyframes)),
      }}
    >
      <DeviceLastScreen
        fallback={<p>Simulator released.</p>}
        platform="ios"
        sessionId="agent-ios-ended"
      />
    </RpcDependenciesProvider>
  );

test("an ended stage shows the last screen kept, or its fallback", () => {
  stage({
    keyframes: [
      { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
      { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
    ],
    retained: true,
  });
  expect(
    screen.getByRole("img", { name: "The last screen this session kept" })
  ).toHaveAttribute(
    "src",
    `/ios/sessions/agent-ios-ended/keyframes/${hash("b")}`
  );
  cleanup();
  stage({
    keyframes: [{ capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") }],
    retained: false,
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Simulator released.")).toBeVisible();
});
