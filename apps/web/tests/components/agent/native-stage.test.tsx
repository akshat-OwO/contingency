import type {
  AndroidWorkspaceObservation,
  NativeTeachingInstruction,
} from "@contingency/protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { NativeStage } from "@/components/agent/android-device";
import type { NativeStream } from "@/components/agent/android-device";
import { NativeCommentComposer } from "@/components/agent/native-comment-composer";
import {
  closedComment,
  commentPick,
  recordingPins,
} from "@/components/agent/native-comment-state";
import type { NativeComment } from "@/components/agent/native-comment-state";
import {
  emptyNativeStreamStats,
  nativeFrameShown,
  nativeFramesDropped,
} from "@/components/agent/native-stream-status";
import type { NativeStreamStats } from "@/components/agent/native-stream-status";
import { WorkspaceRefreshClockContext } from "@/lib/workspace-refresh";

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

/** Counts for `shown` frames 1080 × 2424, each decoded in `decodeMs`. */
const shownFrames = (
  shown: number,
  { decodeMs = 3, dropped = 0, shownAt = performance.now() } = {}
): NativeStreamStats => {
  let stats = nativeFramesDropped(emptyNativeStreamStats, dropped);
  for (let frame = 0; frame < shown; frame += 1) {
    stats = nativeFrameShown(
      stats,
      { decodeMs, height: 2424, width: 1080 },
      shownAt
    );
  }
  return stats;
};

const stream = (change: Partial<NativeStream> = {}): NativeStream => ({
  device: "Pixel_9 · Android 16",
  format: "H.264",
  state: "live",
  stats: () => shownFrames(1204, { dropped: 4 }),
  ...change,
});

/** The card's state row and its terms with their values. */
const diagnostics = () => {
  const card = screen.getByRole("region", { name: "Stream diagnostics" });
  const terms = within(card)
    .getAllByRole("term")
    .map((term) => term.textContent);
  const values = within(card)
    .getAllByRole("definition")
    .map((value) => value.textContent);
  return {
    rows: Object.fromEntries(terms.map((term, i) => [term, values[i]])),
    state: within(card).getByRole("status").parentElement?.textContent,
  };
};

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
  // Only the state is announced; the frame rate beside it changes too often.
  expect(within(card).getByRole("status")).toHaveTextContent(/^Live$/u);
  // The fixture's frames were all shown within the last second, and the
  // frame rate counts the last 120.
  expect(diagnostics()).toEqual({
    rows: {
      "Decode, p95": "3.0 ms",
      "Decoded / dropped": "1,204 / 4",
      Device: "Pixel_9 · Android 16",
      "Input to frame, p95": "—",
      Stream: "H.264 · 1080 × 2424",
    },
    state: "Live · 120 fps",
  });
  expect(within(card).getByText("Last 120 decoded frames.")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "Stream diagnostics" })
  ).toBeNull();
});

test("Stream diagnostics shows frames that arrive after it opens", async () => {
  const user = userEvent.setup();
  const clockScope = await Effect.runPromise(Scope.make());
  const clock = await Effect.runPromise(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, clockScope))
  );
  // The card opens before the first frame, as it does on a fresh stage.
  let counts = emptyNativeStreamStats;
  const stage = (state: "connecting" | "live") => (
    <WorkspaceRefreshClockContext value={clock}>
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
        // A new stream object each render, as the device's parent gives it.
        stream={stream({ state, stats: () => counts })}
        takeover={false}
      >
        <canvas aria-label="Live device display" />
      </NativeStage>
    </WorkspaceRefreshClockContext>
  );
  const { rerender } = render(stage("connecting"));
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  expect(diagnostics()).toEqual({
    rows: {
      "Decode, p95": "—",
      "Decoded / dropped": "0 / 0",
      Device: "Pixel_9 · Android 16",
      "Input to frame, p95": "—",
      Stream: "—",
    },
    state: "Connecting…",
  });
  // The stream goes live: the re-render reads the counts it has now.
  counts = shownFrames(2);
  rerender(stage("live"));
  expect(diagnostics().rows["Decoded / dropped"]).toBe("2 / 0");
  expect(diagnostics().rows.Stream).toBe("H.264 · 1080 × 2424");
  // Without a re-render, the open card re-reads the counts on its beat.
  counts = shownFrames(30, { dropped: 1 });
  await act(() =>
    Effect.runPromise(
      clock.adjust("500 millis").pipe(Effect.timeout("30 seconds"))
    )
  );
  expect(diagnostics().rows["Decoded / dropped"]).toBe("30 / 1");
  await Effect.runPromise(Scope.close(clockScope, Exit.void));
});

test("a still screen reads Live without a frame rate it has not measured", async () => {
  const user = userEvent.setup();
  renderStage({
    stream: stream({
      // Shown long ago: nothing new in the last second.
      stats: () => shownFrames(3, { shownAt: performance.now() - 5000 }),
    }),
  });
  await user.click(screen.getByRole("button", { name: "Stream diagnostics" }));
  expect(diagnostics().state).toBe("Live · 0 fps");
  expect(diagnostics().rows["Decoded / dropped"]).toBe("3 / 0");
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

test("Device settings counts only what this session changed", async () => {
  const user = userEvent.setup();
  const onEmulate = vi.fn();
  // The emulator already reports a location and dark appearance.
  const reported = {
    appearance: "dark",
    location: { latitude: 39.24, longitude: -123.15 },
    orientation: "portrait",
  } as const;
  const { rerender } = renderStage({ emulation: reported, onEmulate });
  const settings = screen.getByRole("button", { name: "Device settings" });
  // The badge is the button's only text.
  expect(settings.textContent).toBe("");
  await user.click(settings);
  const card = screen.getByRole("region", { name: "Device settings" });
  expect(within(card).queryByText(/Applied:/u)).toBeNull();
  const location = within(card).getByRole("group", { name: "Location" });
  expect(
    within(location).getByRole("textbox", { name: "Latitude" })
  ).toBeVisible();
  expect(
    within(card).getByText(
      "Applied to the emulator now. The Flow records them as Teaching evidence."
    )
  ).toBeVisible();
  // Setting a location here is a change, so it reads as applied and counts.
  await user.type(
    within(location).getByRole("textbox", { name: "Latitude" }),
    "12.97"
  );
  await user.type(
    within(location).getByRole("textbox", { name: "Longitude" }),
    "77.59"
  );
  await user.click(within(location).getByRole("button", { name: "Apply" }));
  expect(onEmulate).toHaveBeenLastCalledWith({
    _tag: "location",
    latitude: 12.97,
    longitude: 77.59,
  });
  rerender(
    <NativeStage
      canAct
      emulation={{
        ...reported,
        location: { latitude: 12.97, longitude: 77.59 },
      }}
      frame={{ height: 2424, width: 1080 }}
      lockedReason={undefined}
      observation={observation}
      onActivate={vi.fn()}
      onEmulate={onEmulate}
      onKey={vi.fn()}
      platform="Android"
      stream={stream()}
      takeover={false}
    >
      <canvas aria-label="Live device display" />
    </NativeStage>
  );
  expect(within(card).getByText("Applied: 12.97, 77.59")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Device settings" }).textContent
  ).toBe("1");
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
          instructions={[]}
          onHighlight={vi.fn()}
          pins={[]}
          startedAt={undefined}
        />
      </>
    );
  };
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Attach element" }));
  // A device is touched, not clicked.
  expect(
    screen.getByText("Tap an element to attach it to the comment")
  ).toBeVisible();
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
  const card = screen.getByRole("dialog", { name: "Comment" });
  const chip = card.querySelector('[data-slot="comment-chip"]');
  expect(chip).toHaveTextContent("Checkout");
  // The attached element stays outlined while the comment is open.
  expect(
    document.querySelector('[data-slot="screen-element-highlight"]')
  ).not.toBeNull();
  await user.type(
    screen.getByRole("textbox", { name: "Comment" }),
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
  await user.click(
    screen.getByRole("button", { name: "Remove attached element" })
  );
  expect(card.querySelector('[data-slot="comment-chip"]')).toBeNull();
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

const recordedComments: readonly NativeTeachingInstruction[] = [
  {
    at: "2026-11-18T00:00:05.000Z",
    element: {
      box: { height: 0.1, left: 0.25, top: 0.5, width: 0.5 },
      name: "Checkout",
      role: "button",
    },
    id: "on-screen",
    target: "Checkout button",
    text: "Checkout opens the cart",
  },
  {
    at: "2026-11-18T00:00:09.000Z",
    element: {
      box: { height: 0.1, left: 0.1, top: 0.1, width: 0.2 },
      name: "Back",
      role: "button",
    },
    id: "earlier-screen",
    target: "Back button",
    text: "Back returns to the list",
  },
  {
    at: "2026-11-18T00:00:12.000Z",
    id: "page",
    target: null,
    text: "The cart badge counts items",
  },
];

test("pins the comments whose element is on this screen and lists them all", async () => {
  const user = userEvent.setup();
  const onHighlight = vi.fn();
  const recording = {
    captureState: {
      _tag: "recording" as const,
      startedAt: "2026-11-18T00:00:00.000Z",
    },
    instructions: recordedComments,
    observation,
  };
  const comments = recordingPins(recording, 1);
  renderStage({ comments });
  render(
    <NativeCommentComposer
      attached={undefined}
      canAttach
      instructions={recordedComments}
      onAttach={vi.fn()}
      onCancelPick={vi.fn()}
      onDetach={vi.fn()}
      onDismiss={vi.fn()}
      onHighlight={onHighlight}
      onSubmit={vi.fn()}
      pending={false}
      picking={false}
      pins={comments?.pins ?? []}
      startedAt={recording.captureState.startedAt}
    />
  );
  // Only Checkout is on this screen; Back was on an earlier one.
  const pins = document.querySelector('[data-slot="comment-pins"]');
  expect(pins).toHaveTextContent(/^1$/u);
  const list = screen.getByRole("list", { name: "Earlier comments" });
  const items = within(list).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("The cart badge counts items"),
    expect.stringContaining("Back returns to the list"),
    expect.stringContaining("Checkout opens the cart"),
  ]);
  expect(items[2]).toHaveTextContent("00:05");
  // A native comment is a recorded event: there is no Edit.
  expect(within(list).queryByRole("button")).toBeNull();
  // SAFETY: the list has three items, checked above.
  await user.hover(items[2] as HTMLElement);
  expect(onHighlight).toHaveBeenLastCalledWith(1);
});
