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
  onPatch = vi.fn(),
  currentOrigin?: string
) => {
  render(
    <EmulationPicker
      applied={applied}
      currentOrigin={currentOrigin}
      disabled={false}
      onPatch={onPatch}
    />
  );
  await userEvent.click(screen.getByRole("button", { name: "Emulation" }));
  return onPatch;
};

const locationPicker = {
  emulation: {
    permissions: [],
    viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
  },
  status: "known" as const,
};

const enterLocation = async (latitude = "52.52", longitude = "13.405") => {
  await userEvent.type(screen.getByLabelText("Latitude"), latitude);
  await userEvent.type(screen.getByLabelText("Longitude"), longitude);
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
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
  expect(
    screen.getByText("Granted: geolocation (every website)")
  ).toBeInTheDocument();

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

  expect(
    screen.getByText("Granted: camera (every website)")
  ).toBeInTheDocument();
  expect(
    screen.getByText("Denied: geolocation (every website)")
  ).toBeInTheDocument();
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

test("asks for a location permission decision before applying new coordinates", async () => {
  const onPatch = await openPicker(
    locationPicker,
    vi.fn(),
    "https://shop.example"
  );

  await enterLocation();

  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Apply and grant location" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Apply without permission" })
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(onPatch).not.toHaveBeenCalled();
});

test("grants location to the current website by default", async () => {
  const onPatch = vi.fn();
  await openPicker(locationPicker, onPatch, "https://shop.example");

  await enterLocation();
  await userEvent.click(
    screen.getByRole("button", { name: "Apply and grant location" })
  );

  expect(onPatch).toHaveBeenCalledWith({
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: [
      {
        origin: "https://shop.example",
        permission: "geolocation",
        state: "granted",
      },
    ],
  });
});

test("denies location context-wide when the author selects every website", async () => {
  const onPatch = vi.fn();
  await openPicker(
    {
      emulation: {
        permissions: [
          {
            origin: "https://other.example",
            permission: "geolocation",
            state: "granted",
          },
          { permission: "camera", state: "granted" },
        ],
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      status: "known",
    },
    onPatch,
    "https://shop.example"
  );

  await enterLocation();
  await userEvent.click(
    screen.getByRole("radio", { name: /Every website \(context-wide\)/u })
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Apply without permission" })
  );

  expect(onPatch).toHaveBeenCalledWith({
    geolocation: { latitude: 52.52, longitude: 13.405 },
    permissions: [
      {
        origin: "https://other.example",
        permission: "geolocation",
        state: "granted",
      },
      { permission: "camera", state: "granted" },
      { permission: "geolocation", state: "denied" },
    ],
  });
});

test("uses the only context-wide scope when no website is open", async () => {
  const onPatch = vi.fn();
  await openPicker(locationPicker, onPatch);

  await enterLocation("0", "0");

  const scopes = screen.getAllByRole("radio");
  expect(scopes).toHaveLength(1);
  expect(scopes[0]).toBeChecked();
  expect(
    screen.getByText(
      "No website is open, so this decision applies to every website."
    )
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Apply and grant location" })
  );

  expect(onPatch).toHaveBeenCalledWith({
    geolocation: { latitude: 0, longitude: 0 },
    permissions: [{ permission: "geolocation", state: "granted" }],
  });
});

test("cancelling a location decision leaves the emulation unchanged", async () => {
  const onPatch = vi.fn();
  await openPicker(locationPicker, onPatch, "https://shop.example");

  await enterLocation();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(onPatch).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Apply and grant location" })
  ).not.toBeInTheDocument();
});

test("dismisses a location decision with Escape without applying it", async () => {
  const onPatch = vi.fn();
  await openPicker(locationPicker, onPatch, "https://shop.example");

  await enterLocation();
  await userEvent.keyboard("{Escape}");

  expect(onPatch).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Apply and grant location" })
  ).not.toBeInTheDocument();
});

test.each([
  [
    "context-wide",
    [{ permission: "geolocation", state: "denied" }],
    "https://shop.example",
  ],
  [
    "origin-scoped",
    [
      {
        origin: "https://shop.example",
        permission: "geolocation",
        state: "denied",
      },
    ],
    "https://shop.example",
  ],
] as const)(
  "does not prompt when a %s decision matches",
  async (_scope, permissions, origin) => {
    const onPatch = vi.fn();
    await openPicker(
      {
        emulation: {
          permissions,
          viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
        },
        status: "known",
      },
      onPatch,
      origin
    );

    await enterLocation();

    expect(onPatch).toHaveBeenCalledWith({
      geolocation: { latitude: 52.52, longitude: 13.405 },
    });
    expect(
      screen.queryByRole("button", { name: "Apply and grant location" })
    ).not.toBeInTheDocument();
  }
);

test("prompts for an origin that does not match an existing origin decision", async () => {
  const onPatch = vi.fn();
  await openPicker(
    {
      emulation: {
        permissions: [
          {
            origin: "https://other.example",
            permission: "geolocation",
            state: "granted",
          },
        ],
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      status: "known",
    },
    onPatch,
    "https://shop.example"
  );

  await enterLocation();

  expect(
    screen.getByRole("button", { name: "Apply and grant location" })
  ).toBeInTheDocument();
  expect(onPatch).not.toHaveBeenCalled();
});

test("removes one saved permission decision without changing unrelated decisions", async () => {
  const onPatch = vi.fn();
  await openPicker(
    {
      emulation: {
        permissions: [
          { permission: "geolocation", state: "granted" },
          { permission: "camera", state: "denied" },
        ],
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      status: "known",
    },
    onPatch
  );

  await userEvent.click(
    screen.getByRole("button", {
      name: "Remove geolocation (every website) permission decision",
    })
  );

  expect(onPatch).toHaveBeenCalledWith({
    permissions: [{ permission: "camera", state: "denied" }],
  });
});

test("keeps a saved decision when coordinates are changed or cleared", async () => {
  const onPatch = vi.fn();
  await openPicker(
    {
      emulation: {
        geolocation: { latitude: 52.52, longitude: 13.405 },
        permissions: [
          {
            origin: "https://shop.example",
            permission: "geolocation",
            state: "granted",
          },
          { permission: "camera", state: "denied" },
        ],
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      status: "known",
    },
    onPatch,
    "https://shop.example"
  );

  await userEvent.clear(screen.getByLabelText("Latitude"));
  await userEvent.type(screen.getByLabelText("Latitude"), "48.8566");
  await userEvent.clear(screen.getByLabelText("Longitude"));
  await userEvent.type(screen.getByLabelText("Longitude"), "2.3522");
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(onPatch).toHaveBeenLastCalledWith({
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
  });

  await userEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(onPatch).toHaveBeenLastCalledWith({ geolocation: null });
  expect(
    screen.getByRole("button", {
      name: "Remove geolocation (https://shop.example) permission decision",
    })
  ).toBeInTheDocument();
});
