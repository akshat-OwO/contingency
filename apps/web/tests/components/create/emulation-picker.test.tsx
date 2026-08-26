import { SessionId } from "@contingency/protocol";
import type { RecordingSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { recordingLocksBrowser } from "@/components/create/create-workspace-state";
import { EmulationPicker } from "@/components/create/emulation-picker";

const sessionId = SessionId.make("create-checkout");
const otherSessionId = SessionId.make("create-other");
/** No session selected yet: nothing is locked, because nothing is shown. */
const noSelection: SessionId | undefined = undefined;

afterEach(cleanup);

const openPicker = async (
  applied: Parameters<typeof EmulationPicker>[0]["applied"],
  onPatch = vi.fn()
) => {
  render(
    <EmulationPicker applied={applied} disabled={false} onPatch={onPatch} />
  );
  await userEvent.click(screen.getByRole("button", { name: "Emulation" }));
  return onPatch;
};

test("withholds granting until the session's own permissions are read", async () => {
  await openPicker({ status: "unknown" });

  expect(screen.getByLabelText("Permission to grant")).toBeDisabled();
  expect(
    screen.getByText("Granted permissions are unavailable for this session.")
  ).toBeInTheDocument();
});

test("offers granting once the session's own permissions are read", async () => {
  await openPicker({
    emulation: {
      permissions: [{ permission: "geolocation" }],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    status: "known",
  });

  expect(screen.getByLabelText("Permission to grant")).not.toBeDisabled();
  expect(screen.getByText("Granted: geolocation")).toBeInTheDocument();
});

test("locks the browser controls only for the Recording's own session", () => {
  const recording = { phase: "incomplete", sessionId } as RecordingSnapshot;

  expect(recordingLocksBrowser(recording, sessionId)).toBe(true);
  expect(recordingLocksBrowser(recording, otherSessionId)).toBe(false);
  expect(recordingLocksBrowser(recording, noSelection)).toBe(false);
  expect(recordingLocksBrowser(null, sessionId)).toBe(false);
});
