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

test("withholds a decision until the session's own permissions are read", async () => {
  await openPicker({ status: "unknown" });

  expect(screen.getByLabelText("Permission")).toBeDisabled();
  expect(
    screen.getByText("Permission decisions are unavailable for this session.")
  ).toBeInTheDocument();
});

test("records a decision on top of the ones the session already has", async () => {
  const onPatch = await openPicker({
    emulation: {
      permissions: [{ permission: "geolocation", state: "granted" }],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    status: "known",
  });

  expect(screen.getByLabelText("Permission")).not.toBeDisabled();
  expect(screen.getByText("Granted: geolocation")).toBeInTheDocument();

  await userEvent.click(screen.getByLabelText("Permission"));
  // The Select renders its list in a portal the accessibility tree hides
  // while the popover holds focus, so the option is queried as hidden.
  await userEvent.click(
    screen.getByRole("option", { hidden: true, name: "camera" })
  );
  await userEvent.click(screen.getByRole("button", { name: "Grant" }));

  // A patch replaces the whole list, so a decision carries what the session
  // already had — the contract that makes reading the Emulation necessary.
  expect(onPatch).toHaveBeenCalledWith({
    permissions: [
      { permission: "geolocation", state: "granted" },
      { permission: "camera", state: "granted" },
    ],
  });
});

/**
 * A denial is an answer, not the absence of one: the author says the site is
 * refused, and the Flow carries that ([ADR
 * 0013](../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
test("denying replaces an earlier decision about the same permission", async () => {
  const onPatch = await openPicker({
    emulation: {
      permissions: [
        { permission: "geolocation", state: "granted" },
        { permission: "camera", state: "granted" },
      ],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    status: "known",
  });

  await userEvent.click(screen.getByRole("button", { name: "Deny" }));

  expect(onPatch).toHaveBeenCalledWith({
    permissions: [
      { permission: "camera", state: "granted" },
      { permission: "geolocation", state: "denied" },
    ],
  });
});

test("reads back both granted and denied decisions", async () => {
  await openPicker({
    emulation: {
      permissions: [
        { permission: "geolocation", state: "denied" },
        { permission: "camera", state: "granted" },
      ],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    status: "known",
  });

  expect(screen.getByText("Granted: camera")).toBeInTheDocument();
  expect(screen.getByText("Denied: geolocation")).toBeInTheDocument();
});

test("locks the browser controls only for the Recording's own session", () => {
  const recording = { phase: "incomplete", sessionId } as RecordingSnapshot;

  expect(recordingLocksBrowser(recording, sessionId)).toBe(true);
  expect(recordingLocksBrowser(recording, otherSessionId)).toBe(false);
  expect(recordingLocksBrowser(recording, noSelection)).toBe(false);
  expect(recordingLocksBrowser(null, sessionId)).toBe(false);
});

/**
 * Chromium cannot narrow a context-wide grant back down for one site, so a
 * Flow may not declare both. Granting to every site therefore drops that
 * permission's origin denials rather than composing a set the Flow would
 * refuse to save.
 */
test("granting to every site drops that permission's origin denials", async () => {
  const onPatch = await openPicker({
    emulation: {
      permissions: [
        { permission: "geolocation", state: "denied" },
        {
          origin: "https://example.com",
          permission: "geolocation",
          state: "denied",
        },
        {
          origin: "https://example.com",
          permission: "camera",
          state: "granted",
        },
      ],
      viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
    },
    status: "known",
  });

  await userEvent.click(screen.getByRole("button", { name: "Grant" }));

  expect(onPatch).toHaveBeenCalledWith({
    permissions: [
      {
        origin: "https://example.com",
        permission: "camera",
        state: "granted",
      },
      { permission: "geolocation", state: "granted" },
    ],
  });
});
