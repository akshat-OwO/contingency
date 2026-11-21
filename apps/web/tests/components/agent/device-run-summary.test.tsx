import { AgentSessionId, ContentHash, FlowName } from "@contingency/protocol";
import type { DeviceKeyframes, DeviceVideoStatus } from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  completedAt: "2026-11-05T10:01:04.000Z",
  error: null,
  flowName: FlowName.make("login"),
  id: AgentSessionId.make("agent-ios-ended"),
  kind: "teaching",
  phase: "closed",
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
  startedAt: "2026-11-05T10:00:00.000Z",
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
  // ADR 0078: a device keeps its own facts, never browser Emulation.
  const device = screen.getByRole("region", { name: "Device" });
  expect(device).toHaveTextContent("dev.contingency.login · build 1");
  expect(screen.queryByRole("region", { name: "Emulation" })).toBeNull();
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
  // The frame keeps the live stage's region, with its label on the frame.
  const device = screen.getByRole("region", { name: "iOS simulator" });
  expect(
    within(device).getByRole("img", {
      name: "The last screen this session kept",
    })
  ).toHaveAttribute(
    "src",
    `/ios/sessions/agent-ios-ended/keyframes/${hash("b")}`
  );
  expect(within(device).getByText("Last frame")).toBeVisible();
  expect(screen.queryByRole("figure")).toBeNull();
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

const checkRow = (label: string) => {
  const row = within(
    screen.getByRole("list", { name: "Pass checks" })
  ).getByText(label).parentElement;
  if (row === null) {
    throw new Error(`No ${label} check`);
  }
  return row;
};

test("marks each Capture Gap a fresh observation repaired", async () => {
  render(
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () => Atom.make(Effect.succeed(null)),
        deviceVideoStatusAtom: videoAtom(notRecorded),
      }}
    >
      <DeviceRunSummary
        device="iPhone 17 · iOS 26.5"
        platform="ios"
        session={{
          ...session,
          captureGaps: [
            "capture_incomplete",
            "capture_incomplete",
            "secure_window",
          ],
          captureRepairs: [
            {
              at: "2026-11-15T00:00:00.000Z",
              by: "automatic",
              code: "capture_incomplete",
            },
          ],
          kind: "dry-run",
        }}
        targetApp="dev.contingency.login · build 1"
      />
    </RpcDependenciesProvider>
  );
  // Two gaps were never repaired, so the Dry Run cannot pass.
  expect(
    within(checkRow("Capture complete")).getByLabelText("Failed")
  ).toBeVisible();
  expect(checkRow("Capture complete")).toHaveTextContent("2 open gaps");
  // A Dry Run keeps its device facts in the Task segment.
  await userEvent.click(screen.getByRole("tab", { name: "Task" }));
  expect(
    within(screen.getByRole("region", { name: "Device" })).getByText(
      "Capture incomplete (repaired automatically), Capture incomplete, Secure window"
    )
  ).toBeVisible();
});

const dryRun = (
  overrides: Partial<{
    readonly assessment: {
      readonly explanation: string;
      readonly observationId: string;
      readonly outcome: "working" | "inconclusive" | "not-working" | "blocked";
    } | null;
    readonly takeoverOccurred: boolean;
  }>,
  video: DeviceVideoStatus | null = notRecorded
) =>
  render(
    <RpcDependenciesProvider
      overrides={{
        deviceKeyframesAtom: () =>
          Atom.make(
            Effect.succeed({
              keyframes: [
                { capturedAt: "2026-11-05T10:00:00.000Z", hash: hash("a") },
                { capturedAt: "2026-11-05T10:00:05.000Z", hash: hash("b") },
              ],
              retained: true,
            })
          ),
        deviceVideoStatusAtom: videoAtom(video),
      }}
    >
      <DeviceRunSummary
        device="iPhone 17 · iOS 26.5"
        platform="ios"
        session={{
          ...session,
          assessment: {
            explanation: "The welcome screen named the plan.",
            observationId: "observation-7",
            outcome: "working",
          },
          kind: "dry-run",
          recordingId: null,
          ...overrides,
        }}
        targetApp="dev.contingency.login · build 1"
      />
    </RpcDependenciesProvider>
  );

test("an ended Dry Run reads like the browser's Run Summary", async () => {
  dryRun({});
  expect(screen.getByText("Dry Run passed")).toBeVisible();
  expect(
    screen.getByRole("heading", { level: 3, name: "Dry Run of login" })
  ).toBeVisible();
  // The Agent Assessment explains the verdict, in the verdict header.
  expect(
    within(screen.getByRole("region", { name: "Run verdict" })).getByText(
      "The welcome screen named the plan."
    )
  ).toBeVisible();
  expect(screen.getByRole("region", { name: "Run video" })).toBeVisible();
  const stats = screen.getByText("Duration", { selector: "dt" }).closest("dl");
  expect(stats).toHaveTextContent("1m 04s");
  expect(stats).toHaveTextContent("Screens2");
  const tabs = screen.getByRole("tablist", { name: "Run Summary sections" });
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent)
  ).toStrictEqual(["Pass checks", "Findings 0", "Task"]);
  for (const label of [
    "Run finished",
    "Agent Assessment",
    "No Takeover",
    "Capture complete",
  ]) {
    expect(within(checkRow(label)).getByLabelText("Passed")).toBeVisible();
  }
  // ADR 0078: no browser check or scan applies to a device.
  expect(screen.queryByText("Browser Checks")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Copy observation observation-7" })
  ).toBeVisible();
  // An ended live session names itself; its Run ID is the persisted record's.
  expect(
    screen.getByRole("button", { name: "Copy Session ID agent-ios-ended" })
  ).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Task" }));
  const device = screen.getByRole("region", { name: "Device" });
  expect(device).toHaveTextContent("iPhone 17 · iOS 26.5");
  expect(device).toHaveTextContent("dev.contingency.login · build 1");
  expect(
    within(screen.getByRole("region", { name: "Referenced flows" })).getByRole(
      "link",
      { name: "login" }
    )
  ).toHaveAttribute("href", "/flow?flow=login");
  expect(screen.queryByRole("region", { name: "Emulation" })).toBeNull();
});

test("a Dry Run after a Takeover says why it cannot pass", () => {
  dryRun({
    assessment: {
      explanation: "The agent reached the welcome screen.",
      observationId: "observation-7",
      outcome: "inconclusive",
    },
    takeoverOccurred: true,
  });
  expect(screen.getByText("Dry Run failed")).toBeVisible();
  // The runtime turned the assessment inconclusive for the Takeover, so the
  // Takeover leads.
  expect(
    screen.getByText("You took control during this Dry Run, so it cannot pass.")
  ).toBeVisible();
  expect(
    within(checkRow("No Takeover")).getByLabelText("Failed")
  ).toBeVisible();
});

test("a Dry Run's screens stand in only for a video it cannot play", () => {
  dryRun({}, ready);
  expect(screen.getByLabelText("Recorded Run video")).toHaveAttribute(
    "src",
    "/ios/sessions/agent-ios-ended/video"
  );
  expect(screen.queryByRole("list", { name: "Screens" })).toBeNull();
  cleanup();
  dryRun({});
  expect(
    within(screen.getByRole("region", { name: "Run video" })).getByRole(
      "list",
      { name: "Screens" }
    )
  ).toBeVisible();
});
