import type { AndroidWorkspaceObservation } from "@contingency/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { NativeStage } from "@/components/agent/android-device";
import type { NativeStream } from "@/components/agent/android-device";
import { NativeCommentComposer } from "@/components/agent/native-comment-composer";
import {
  closedComment,
  commentPick,
} from "@/components/agent/native-comment-state";
import type { NativeComment } from "@/components/agent/native-comment-state";

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

const frameWidth = () =>
  screen
    .getByLabelText("Live device display")
    .closest<HTMLElement>('[style*="width"]')?.style.width;

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

test("closing a focused card returns focus to its rail button", async () => {
  const user = userEvent.setup();
  renderStage();
  const open = screen.getByRole("button", { name: "Stream diagnostics" });
  await user.click(open);
  await user.click(
    screen.getByRole("button", { name: "Close Stream diagnostics" })
  );
  expect(open).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Device settings" }));
  await user.click(screen.getByRole("radio", { name: "Dark" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Device settings" })).toBeNull();
  expect(screen.getByRole("button", { name: "Device settings" })).toHaveFocus();
});

test("the frame keeps room for the cards beside it", async () => {
  const user = userEvent.setup();
  const { rerender } = renderStage({ frame: { height: 1080, width: 2424 } });
  expect(frameWidth()).toContain("100cqw - 64px");
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  // The card is 332px wide; the row stays centred, so both sides keep it.
  expect(frameWidth()).toContain("100cqw - 728px");
  await user.keyboard("{Escape}");
  rerender(
    <NativeStage
      canAct
      emulation={undefined}
      frame={{ height: 1080, width: 2424 }}
      leading={<form aria-label="Field Variable" />}
      lockedReason={undefined}
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
  expect(frameWidth()).toContain("100cqw - 664px");
});

test("an iOS comment attaches a picked element, and the screen gets no touch", async () => {
  const user = userEvent.setup();
  const onActivate = vi.fn();
  const onSubmit = vi.fn();
  const Harness = () => {
    const [comment, setComment] = useState<NativeComment>({
      ...closedComment,
      open: true,
    });
    return (
      <>
        <NativeStage
          canAct
          emulation={undefined}
          frame={{ height: 2622, width: 1206 }}
          lockedReason={undefined}
          observation={observation}
          onActivate={onActivate}
          onEmulate={vi.fn()}
          onKey={vi.fn()}
          pick={commentPick(comment, setComment)}
          platform="iOS"
          stream={stream({ format: "JPEG" })}
          takeover={false}
        >
          <canvas aria-label="Live device display" />
        </NativeStage>
        <NativeCommentComposer
          attached={comment.attached ?? undefined}
          canAttach
          onAttach={() =>
            setComment((current) => ({ ...current, picking: true }))
          }
          onCancelPick={() =>
            setComment((current) => ({ ...current, picking: false }))
          }
          onDetach={() =>
            setComment((current) => ({ ...current, attached: null }))
          }
          onDismiss={() => setComment(() => closedComment)}
          onSubmit={(text) => onSubmit(text, comment.attached)}
          pending={false}
          picking={comment.picking}
        />
      </>
    );
  };
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Attach element" }));
  const picker = document.querySelector<HTMLElement>(
    '[data-slot="element-picker"]'
  );
  if (picker === null) {
    throw new Error("The element picker must cover the screen.");
  }
  vi.spyOn(picker, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ height: 800, width: 400, x: 0, y: 0 })
  );
  // Nothing named sits here, so a click attaches nothing.
  fireEvent.pointerUp(picker, { clientX: 20, clientY: 20 });
  expect(screen.getByRole("button", { name: "Attach element" })).toBeVisible();
  fireEvent.pointerUp(picker, { clientX: 200, clientY: 440 });
  const chip = document.querySelector('[data-slot="comment-element"]');
  expect(chip).toHaveTextContent("Checkout");
  // The attached element stays outlined while the comment is open.
  expect(
    document.querySelector('[data-slot="screen-element-highlight"]')
  ).not.toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Instruction" }),
    "Checkout opens the cart{Enter}"
  );
  expect(onSubmit).toHaveBeenCalledWith(
    "Checkout opens the cart",
    expect.objectContaining({
      label: "Checkout",
      observationId: "observation-1",
      target: "@checkout",
    })
  );
  await user.click(screen.getByRole("button", { name: "Detach Checkout" }));
  expect(document.querySelector('[data-slot="comment-element"]')).toBeNull();
  expect(onActivate).not.toHaveBeenCalled();
});

test("a click on a control's label attaches the control, not its text", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  renderStage({
    observation: {
      ...observation,
      nodes: [
        ...observation.nodes,
        {
          bounds: { height: 30, width: 120, x: 140, y: 425 },
          covered: false,
          editable: false,
          name: "Checkout",
          password: false,
          role: "text",
          target: "@checkout-label",
        },
      ],
    },
    pick: { attached: undefined, onCancel: vi.fn(), onPick, picking: true },
  });
  const picker = document.querySelector<HTMLElement>(
    '[data-slot="element-picker"]'
  );
  if (picker === null) {
    throw new Error("The element picker must cover the screen.");
  }
  vi.spyOn(picker, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ height: 800, width: 400, x: 0, y: 0 })
  );
  fireEvent.pointerUp(picker, { clientX: 200, clientY: 440 });
  expect(onPick).toHaveBeenCalledWith(
    expect.objectContaining({ role: "button", target: "@checkout" })
  );
  // Screen elements is the keyboard path to the same element.
  await user.click(
    within(screen.getByRole("region", { name: "Screen elements" })).getByRole(
      "button",
      { name: "Attach Checkout" }
    )
  );
  expect(onPick).toHaveBeenLastCalledWith(
    expect.objectContaining({ target: "@checkout" })
  );
});
