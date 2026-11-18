import type { AndroidWorkspaceObservation } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { NativeStage } from "@/components/agent/android-device";
import type { NativeStream } from "@/components/agent/android-device";

afterEach(cleanup);

const observation: AndroidWorkspaceObservation = {
  capturedAt: "2026-11-18T00:00:00.000Z",
  height: 800,
  id: "observation-1",
  image: null,
  nodes: [
    {
      bounds: { height: 80, width: 200, x: 100, y: 400 },
      covered: false,
      editable: false,
      name: "Checkout",
      password: false,
      role: "button",
      target: "@checkout",
    },
  ],
  width: 400,
};

const stream = (change: Partial<NativeStream> = {}): NativeStream => ({
  device: "Pixel_9",
  format: "H.264",
  state: "live",
  stats: () => ({
    codec: "avc1.42E01F",
    decoded: 1204,
    height: 2424,
    resyncs: 2,
    width: 1080,
  }),
  ...change,
});

const renderStage = (props: Partial<Parameters<typeof NativeStage>[0]> = {}) =>
  render(
    <NativeStage
      canAct
      emulation={undefined}
      frame={{ height: 2424, width: 1080 }}
      lockedReason={undefined}
      observation={observation}
      onActivate={vi.fn()}
      onEmulate={vi.fn()}
      onKey={vi.fn()}
      platform="Android"
      stream={stream()}
      takeover={false}
      {...props}
    >
      <canvas aria-label="Live device display" />
    </NativeStage>
  );

test("Screen elements opens beside the rail and outlines the hovered element", async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn();
  renderStage({ onActivate });
  const open = screen.getByRole("button", { name: "Screen elements" });
  expect(open).toHaveAttribute("aria-description", "1 element on screen");
  await user.click(open);
  const card = screen.getByRole("region", { name: "Screen elements" });
  const checkout = within(card).getByRole("button", {
    name: "Activate Checkout",
  });
  await user.hover(checkout);
  const outline = document.querySelector(
    '[data-slot="screen-element-highlight"]'
  );
  expect(outline).toHaveStyle({
    height: "10%",
    left: "25%",
    top: "50%",
    width: "50%",
  });
  // Activating taps the device and gives the screen back.
  await user.click(checkout);
  expect(onActivate).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: "Screen elements" })).toBeNull();
  expect(
    document.querySelector('[data-slot="screen-element-highlight"]')
  ).toBeNull();
});

test("Stream diagnostics reads the stream, and Escape closes it", async () => {
  const user = userEvent.setup();
  renderStage();
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  const card = screen.getByRole("region", { name: "Stream diagnostics" });
  expect(within(card).getByRole("status")).toHaveTextContent("Live");
  const terms = within(card)
    .getAllByRole("term")
    .map((term) => term.textContent);
  const values = within(card)
    .getAllByRole("definition")
    .map((value) => value.textContent);
  expect(Object.fromEntries(terms.map((term, i) => [term, values[i]]))).toEqual(
    {
      Device: "Pixel_9",
      "Frames shown": "1,204",
      "Keyframe rejoins": "2",
      Stream: "avc1.42E01F · 1080 × 2424",
    }
  );
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Stream diagnostics" })
  ).toBeNull();
});

test("a lost stream offers Reconnect even while the agent drives", async () => {
  const user = userEvent.setup();
  const onReconnect = vi.fn();
  renderStage({
    canAct: false,
    lockedReason: "The agent is driving. Take control to use the device.",
    stream: stream({ onReconnect, state: "lost" }),
  });
  expect(
    screen.getByRole("button", { name: "Screen elements" })
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  await user.click(
    screen.getByRole("button", { name: "Reconnect device stream" })
  );
  expect(onReconnect).toHaveBeenCalledOnce();
});

test("losing control closes the cards only the person in control can use", async () => {
  const user = userEvent.setup();
  const { rerender } = renderStage();
  await user.click(screen.getByRole("button", { name: "Device settings" }));
  expect(screen.getByRole("region", { name: "Device settings" })).toBeVisible();
  rerender(
    <NativeStage
      canAct={false}
      emulation={undefined}
      frame={{ height: 2424, width: 1080 }}
      lockedReason="The agent is driving. Take control to use the device."
      observation={observation}
      onActivate={vi.fn()}
      onEmulate={vi.fn()}
      onKey={vi.fn()}
      platform="Android"
      stream={stream()}
      takeover={false}
    >
      <canvas aria-label="Live device display" />
    </NativeStage>
  );
  expect(screen.queryByRole("region", { name: "Device settings" })).toBeNull();
});

test("the Field Variable card and the cards sit beside the frame, not on it", async () => {
  const user = userEvent.setup();
  renderStage({ leading: <form aria-label="Field Variable" /> });
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  // The glass holds the stream and nothing else that takes input.
  const glass = screen.getByLabelText("Live device display").parentElement;
  for (const element of [
    screen.getByRole("form", { name: "Field Variable" }),
    screen.getByRole("region", { name: "Stream diagnostics" }),
    screen.getByRole("navigation", { name: "Device controls" }),
  ]) {
    expect(glass?.contains(element)).toBe(false);
  }
});
