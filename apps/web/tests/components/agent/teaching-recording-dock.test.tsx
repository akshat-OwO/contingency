import type { TeachingCaptureState } from "@contingency/protocol";
import { RegistryProvider } from "@effect/atom-react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { TeachingRecordingDock } from "@/components/agent/teaching-recording-dock";

afterEach(cleanup);

const dryRunPassed: TeachingCaptureState = {
  _tag: "dry-run-passed",
  draftedAt: "2026-09-18T00:00:05.000Z",
  dryRunResult: {
    observableOutcome: "The anvil is in the cart.",
    passed: true,
    reportedAt: "2026-09-18T00:00:08.000Z",
  },
  dryRunStartedAt: "2026-09-18T00:00:06.000Z",
  readyAt: "2026-09-18T00:00:04.000Z",
  startedAt: "2026-09-18T00:00:01.000Z",
  stoppedAt: "2026-09-18T00:00:03.000Z",
};

const Dock = ({
  captureState,
  docked,
}: {
  readonly captureState: TeachingCaptureState;
  readonly docked: boolean;
}) => (
  <RegistryProvider>
    <TeachingRecordingDock
      captureState={captureState}
      cleanup={undefined}
      controller="user"
      flowDecisionDocked={docked}
      flowName="add-anvil"
      instructions={[]}
      onComment={() => {}}
      onGesture={() => {}}
      onSecondary={() => {}}
      pending={false}
      phase="running"
      platform="mac"
      selectedSessionId={undefined}
      sessions={[]}
    />
  </RegistryProvider>
);

test("a passed Dry Run is decided in the status island until a Flow decision docks", () => {
  render(<Dock captureState={dryRunPassed} docked={false} />);
  const status = screen.getByRole("region", { name: "Session status" });
  expect(
    within(status).getByRole("button", { name: "Verify flow" })
  ).toBeVisible();
  expect(
    within(status).getByRole("button", { name: "Reject flow" })
  ).toBeVisible();
});

test("a docked Flow decision takes Verify flow and Reject flow from the island", () => {
  render(<Dock captureState={dryRunPassed} docked />);
  const status = screen.getByRole("region", { name: "Session status" });
  expect(
    within(status).queryByRole("button", { name: "Verify flow" })
  ).toBeNull();
  expect(
    within(status).queryByRole("button", { name: "Reject flow" })
  ).toBeNull();
});

test("Teaching handed to the user reads Ready, with Start recording filled red", () => {
  render(
    <Dock
      captureState={{ _tag: "setup", requestedAt: "2026-09-18T00:00:00.000Z" }}
      docked
    />
  );
  const status = screen.getByRole("region", { name: "Session status" });
  // Handed to the user: the Ready chip, and Start recording filled red.
  expect(within(status).getByText("Ready")).toHaveAttribute(
    "data-status",
    "ready"
  );
  expect(
    within(status).getByRole("button", { name: "Start recording" })
  ).toHaveClass("bg-status-recording");
});

test("the recording chip holds the elapsed time; Stop is filled neutral", () => {
  render(
    <Dock
      captureState={{
        _tag: "recording",
        startedAt: new Date().toISOString(),
      }}
      docked={false}
    />
  );
  const status = screen.getByRole("region", { name: "Session status" });
  const chip = within(status).getByText("Recording", { exact: false });
  expect(within(chip).getByRole("timer")).toHaveTextContent(/^\d{2}:\d{2}$/u);
  const stop = within(status).getByRole("button", { name: "Stop recording" });
  expect(stop).toHaveTextContent("Stop");
  expect(stop).toHaveClass("bg-primary");
  // No keycaps in the island; the chord is announced and in the tooltip.
  const comment = within(status).getByRole("button", { name: "Comment" });
  expect(comment).not.toHaveTextContent("⌘");
  expect(comment).toHaveAttribute("aria-keyshortcuts", "/ Meta+Shift+K");
});
