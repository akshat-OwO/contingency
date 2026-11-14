import { AgentSessionId, ContentHash } from "@contingency/protocol";
import type { DeviceKeyframes, DeviceVideoStatus } from "@contingency/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { afterEach, expect, test } from "vitest";

import {
  DeviceLastScreen,
  DeviceRunSummary,
} from "@/components/agent/android-run-summary";
import { deviceCleanupKey } from "@/components/agent/android-workspace-state";
import { RpcDependenciesProvider } from "@/lib/rpc-dependencies";

afterEach(cleanup);

const session = {
  assessment: null,
  captureGaps: [],
  cleanup: null,
  error: null,
  id: AgentSessionId.make("agent-ios-ended"),
  kind: "teaching",
  recordingId: null,
  requirements: {
    capabilities: ["semantic-actions", "screenshots"],
    environment: {
      build: "1",
      bundleId: "dev.shop",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtimeVersion: "26.0",
    },
    platform: "ios",
    preparation: { conditions: [], kind: "restart-app", startingData: "clear" },
  },
  takeoverOccurred: false,
} as const;

const notRecorded: DeviceVideoStatus = {
  reason: "This session kept no video.",
  state: "not-recorded",
};
const videoAtom = (video: DeviceVideoStatus | null) => () =>
  Atom.make(Effect.succeed(video));

const summary = (
  keyframes: DeviceKeyframes | null | Error,
  video: DeviceVideoStatus | null = notRecorded
) =>
  render(
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () =>
          Atom.make(
            keyframes instanceof Error
              ? Effect.fail(keyframes)
              : Effect.succeed(keyframes)
          ),
        deviceVideoStatusAtom: videoAtom(video),
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

interface PurgedCleanup {
  readonly _tag: "purged";
  readonly completedAt: string;
}
const purged: PurgedCleanup = {
  _tag: "purged",
  completedAt: "2026-11-05T10:05:00.000Z",
};

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
  summary(null, null);
  expect(
    screen.getByText(
      /This Workspace no longer holds the session, so its screens/u
    )
  ).toBeVisible();
  expect(
    screen.getByText(
      /This Workspace no longer holds the session, so its video/u
    )
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
        cleanup="none"
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

test("one kept screen is left to the stage, not drawn twice", () => {
  summary({
    keyframes: [{ capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") }],
    retained: true,
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByText(/The one screen this session kept is on the stage/u)
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Full size" })).toHaveAttribute(
    "href",
    `/ios/sessions/agent-ios-ended/keyframes/${hash("a")}`
  );
});

test("a mounted ended session drops its screens when cleanup purges them", async () => {
  let served: DeviceKeyframes = {
    keyframes: [
      { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
      { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
    ],
    retained: true,
  };
  // One list atom, read again on refresh, as the Workspace's family is.
  const list = Atom.make(Effect.sync(() => served));
  const view = (cleanupState: typeof session.cleanup | PurgedCleanup) => (
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () => list,
        deviceVideoStatusAtom: videoAtom(notRecorded),
      }}
    >
      <DeviceLastScreen
        cleanup={deviceCleanupKey(cleanupState)}
        fallback={<p>Simulator released.</p>}
        platform="ios"
        sessionId="agent-ios-ended"
      />
      <DeviceRunSummary
        device="iPhone 17 · iOS 26.5"
        platform="ios"
        session={{ ...session, cleanup: cleanupState }}
        targetApp="dev.contingency.login · build 1"
      />
    </RpcDependenciesProvider>
  );
  const { rerender } = render(view(null));
  expect(
    screen.getByRole("img", { name: "The last screen this session kept" })
  ).toBeVisible();
  // Verification purges the recording and its screens.
  served = { ...served, retained: false };
  rerender(view(purged));
  expect(
    await screen.findByText(/Cleanup deleted the 2 screens this session kept/u)
  ).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Simulator released.")).toBeVisible();
});

const ready: DeviceVideoStatus = {
  capture: {
    complete: false,
    gaps: [{ fromMs: 6000, reason: "recorder-lost", toMs: 9000 }],
    hidden: [{ fromMs: 1000, toMs: 3000 }],
  },
  pacing: "real-time",
  path: "/catalog/runs/agentrun-1/video/video.webm",
  state: "ready",
  timeMap: {
    fastForward: "capped",
    segments: [
      {
        kind: "real-time",
        rate: 1,
        runFromMs: 0,
        runToMs: 9000,
        videoFromMs: 0,
        videoToMs: 9000,
      },
    ],
    startedAt: "2026-11-05T10:00:00.000Z",
  },
};

test("plays the session's video and says what it does not show", () => {
  summary(
    {
      keyframes: [
        { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
        { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
      ],
      retained: true,
    },
    ready
  );
  const video = screen.getByLabelText("Recorded Teaching session video");
  expect(video).toHaveAttribute("src", "/ios/sessions/agent-ios-ended/video");
  expect(
    screen.getByText(
      /The video is incomplete: about 3 s was not recorded, because of the recorder stopping unexpectedly/u
    )
  ).toBeVisible();
  expect(screen.getByText(/Secure screens are hidden for 2 s/u)).toBeVisible();
  // Each kept screen can be shown in the video.
  expect(
    screen.getByRole("button", { name: "Show screen 1 in the video" })
  ).toHaveTextContent("In video");
  expect(
    screen.getByRole("button", { name: "Show screen 2 in the video" })
  ).toBeVisible();
});

test("a chosen screen moves the video to its moment", () => {
  summary(
    {
      keyframes: [
        { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
        { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
      ],
      retained: true,
    },
    ready
  );
  const video = screen.getByLabelText<HTMLVideoElement>(
    "Recorded Teaching session video"
  );
  // jsdom loads no media; the element reports a known duration instead.
  Object.defineProperty(video, "duration", { configurable: true, value: 9 });
  fireEvent.loadedMetadata(video);
  fireEvent.click(
    screen.getByRole("button", { name: "Show screen 2 in the video" })
  );
  expect(video.currentTime).toBe(5);
});

test("says why there is no video to play", () => {
  summary({ keyframes: [], retained: true }, { state: "preparing" });
  expect(screen.getByText("Preparing video…")).toBeVisible();
  cleanup();
  summary({ keyframes: [], retained: true }, { state: "purged" });
  expect(
    screen.getByText(/Cleanup deleted this session's video/u)
  ).toBeVisible();
  cleanup();
  summary(
    { keyframes: [], retained: true },
    {
      directory: "/catalog/runs/agentrun-1/video",
      reason: "The recording was never finalized.",
      state: "unavailable",
    }
  );
  expect(screen.getByText("The recording was never finalized.")).toBeVisible();
  expect(screen.queryByText("In video")).toBeNull();
});

test("names the Starting Data the session applied", () => {
  summary(null);
  expect(screen.getByText("Starting data")).toBeTruthy();
  expect(screen.getByText("App data cleared")).toBeTruthy();
});
