import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  checkServer,
  mount,
  partAttrs,
  partPresent,
  partState,
} from "@ui-sdk/core/testing";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { DecisionId } from "@/components/agent/dock-request-parts";
import { EvidenceReference } from "@/components/agent/evidence-reference";
import { RunVideoPlayer } from "@/components/agent/run-video";
import {
  CopyButton,
  CopyButtonFallback,
  CopyButtonTrigger,
  copyButton,
} from "@/components/ui/copy-button";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

let previousStrict: boolean | undefined;
let originalClipboard: PropertyDescriptor | undefined;

const setClipboard = (clipboard: { writeText?: unknown } | undefined) => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeAll(() => {
  previousStrict = globalThis.__UI_SDK_STRICT__;
  globalThis.__UI_SDK_STRICT__ = true;
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
});

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrict;
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalClipboard === undefined) {
    Reflect.deleteProperty(navigator, "clipboard");
  } else {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  }
});

test("renders pure attributes and state on the server", () => {
  const html = checkServer(
    copyButton,
    { value: "agentrun-1" },
    '<root><trigger as="button">Copy</trigger><fallback>Failed</fallback></root>'
  );
  expect(html).toContain('data-slot="copy-button"');
  expect(html).toContain('data-slot="copy-button-trigger"');
  expect(html).toContain('data-status="idle"');
  expect(html).toContain('type="button"');
  expect(html).not.toContain('data-slot="copy-button-fallback"');

  const instance = copyButton({ value: "agentrun-1" });
  try {
    const root = instance.part("root", {});
    expect(partAttrs(root)).toMatchObject({ "data-status": "idle" });
    expect(partAttrs(root)).not.toHaveProperty("data-copied");
    expect(partAttrs(root)).not.toHaveProperty("data-failed");

    const trigger = instance.part("trigger", {});
    expect(partAttrs(trigger)).toMatchObject({
      "data-status": "idle",
      type: "button",
    });
    expect(partState(trigger)).toEqual({
      copied: false,
      failed: false,
      status: "idle",
    });

    const fallback = instance.part("fallback", {});
    expect(partPresent(fallback)).toBe(false);
    expect(partState(fallback)).toEqual({ value: "agentrun-1" });
  } finally {
    instance.destroy();
  }
});

test("copies via pointer click, Enter, and Space", async () => {
  const writeText = vi.fn().mockResolvedValue();
  setClipboard({ writeText });

  const view = mount(
    copyButton,
    { value: "agentrun-keyboard" },
    '<root><trigger as="button">Copy</trigger><fallback>Failed</fallback></root>'
  );
  try {
    const trigger = view.part("trigger");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Expected button trigger");
    }

    await view.click(trigger);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith("agentrun-keyboard");
    expect(view.state.status).toBe("copied");
    expect(trigger).toHaveAttribute("data-status", "copied");
    expect(trigger).toHaveAttribute("data-copied", "");
    expect(trigger).not.toHaveAttribute("data-failed");

    trigger.focus();
    await view.keys("Enter");
    expect(writeText).toHaveBeenCalledTimes(2);

    await view.keys("Space");
    expect(writeText).toHaveBeenCalledTimes(3);
  } finally {
    view.unmount();
  }
});

test("resets copied status after 2000ms so a later copy reports again", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue();
  setClipboard({ writeText });

  const view = mount(
    copyButton,
    { value: "agentrun-reset" },
    '<root><trigger as="button">Copy</trigger></root>'
  );
  try {
    const trigger = view.part("trigger");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Expected button trigger");
    }

    trigger.click();
    await flushMicrotasks();
    expect(view.state.status).toBe("copied");

    await vi.advanceTimersByTimeAsync(1999);
    expect(view.state.status).toBe("copied");

    await vi.advanceTimersByTimeAsync(1);
    expect(view.state.status).toBe("idle");
    expect(trigger).toHaveAttribute("data-status", "idle");
    expect(trigger).not.toHaveAttribute("data-copied");

    trigger.click();
    await flushMicrotasks();
    expect(view.state.status).toBe("copied");
  } finally {
    view.unmount();
  }
});

test("rapid re-copy cancels the pending reset timer", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue();
  setClipboard({ writeText });

  const view = mount(
    copyButton,
    { value: "agentrun-rapid" },
    '<root><trigger as="button">Copy</trigger></root>'
  );
  try {
    const trigger = view.part("trigger");
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error("Expected button trigger");
    }

    trigger.click();
    await flushMicrotasks();
    expect(view.state.status).toBe("copied");

    await vi.advanceTimersByTimeAsync(1500);
    expect(view.state.status).toBe("copied");

    // Second copy cancels the t=2000 reset and starts a new 2000ms window.
    trigger.click();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1000);
    expect(view.state.status).toBe("copied");

    await vi.advanceTimersByTimeAsync(999);
    expect(view.state.status).toBe("copied");

    await vi.advanceTimersByTimeAsync(1);
    expect(view.state.status).toBe("idle");
  } finally {
    view.unmount();
  }
});

const ValueChangeHarness = ({ value }: { readonly value: string }) => (
  <CopyButton value={value}>
    <CopyButtonTrigger aria-label="Copy id">
      {({ copied }) => (copied ? "Copied" : "Copy")}
    </CopyButtonTrigger>
    <CopyButtonFallback message="Copy failed." />
  </CopyButton>
);

test("stale in-flight clipboard write cannot overwrite a newer copy", async () => {
  vi.useFakeTimers();
  const firstDeferred = Promise.withResolvers<undefined>();
  const secondDeferred = Promise.withResolvers<undefined>();
  const writeText = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => firstDeferred.promise)
    .mockImplementationOnce(() => secondDeferred.promise);
  setClipboard({ writeText });

  const view = mount(
    copyButton,
    { value: "agentrun-race" },
    '<root><trigger as="button">Copy</trigger><fallback>Failed</fallback></root>'
  );
  try {
    const first = view.api.copy();
    const second = view.api.copy();

    secondDeferred.resolve();
    expect(await second).toBe(true);
    expect(view.state.status).toBe("copied");

    firstDeferred.reject(new Error("stale rejection"));
    expect(await first).toBe(false);
    expect(view.state.status).toBe("copied");
    expect(view.part("fallback")?.isConnected).toBe(false);
  } finally {
    view.unmount();
  }
});

test("unmounting during a pending reset or in-flight writeText performs no state update", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue();
  setClipboard({ writeText });

  // Unmount during pending reset timer.
  const resetView = mount(
    copyButton,
    { value: "agentrun-unmount-timer" },
    '<root><trigger as="button">Copy</trigger></root>'
  );
  await resetView.api.copy();
  expect(resetView.state.status).toBe("copied");
  resetView.unmount();
  await vi.advanceTimersByTimeAsync(5000);
  expect(resetView.state.status).toBe("copied");

  // Unmount while writeText is pending, then resolve.
  const pendingResolveDeferred = Promise.withResolvers<undefined>();
  setClipboard({
    writeText: vi.fn(() => pendingResolveDeferred.promise),
  });
  const pendingResolveView = mount(
    copyButton,
    { value: "agentrun-unmount-resolve" },
    '<root><trigger as="button">Copy</trigger></root>'
  );
  const pendingResolve = pendingResolveView.api.copy();
  pendingResolveView.unmount();
  pendingResolveDeferred.resolve();
  expect(await pendingResolve).toBe(false);
  expect(pendingResolveView.state.status).toBe("idle");

  // Unmount while writeText is pending, then reject.
  const pendingRejectDeferred = Promise.withResolvers<undefined>();
  setClipboard({
    writeText: vi.fn(() => pendingRejectDeferred.promise),
  });
  const pendingRejectView = mount(
    copyButton,
    { value: "agentrun-unmount-reject" },
    '<root><trigger as="button">Copy</trigger></root>'
  );
  const pendingReject = pendingRejectView.api.copy();
  pendingRejectView.unmount();
  pendingRejectDeferred.reject(new Error("denied"));
  expect(await pendingReject).toBe(false);
  expect(pendingRejectView.state.status).toBe("idle");
});

test("handles clipboard rejection, missing navigator.clipboard, and clears failure on subsequent success", async () => {
  vi.useFakeTimers();
  const writeText = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("permission denied"))
    .mockResolvedValueOnce();
  setClipboard({ writeText });

  const view = mount(
    copyButton,
    { value: "agentrun-fail" },
    '<root><trigger as="button">Copy</trigger><fallback>Failed</fallback></root>'
  );
  try {
    expect(await view.api.copy()).toBe(false);
    expect(view.state.status).toBe("failed");
    expect(view.part("trigger")).toHaveAttribute("data-status", "failed");
    expect(view.part("trigger")).toHaveAttribute("data-failed", "");
    expect(view.part("fallback")?.isConnected).toBe(true);

    // Failure stays visible past the 2000ms reset window so users can copy the fallback.
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.state.status).toBe("failed");
    expect(view.part("fallback")?.isConnected).toBe(true);

    // Subsequent success clears the failure and unmounts fallback.
    expect(await view.api.copy()).toBe(true);
    expect(view.state.status).toBe("copied");
    expect(view.part("trigger")).toHaveAttribute("data-copied", "");
    expect(view.part("trigger")).not.toHaveAttribute("data-failed");
    expect(view.part("fallback")?.isConnected).toBe(false);

    // A failure during an active copied reset cancels that reset timer.
    writeText.mockRejectedValueOnce(new Error("blocked again"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await view.api.copy()).toBe(false);
    expect(view.state.status).toBe("failed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.state.status).toBe("failed");
  } finally {
    view.unmount();
  }

  // Missing navigator.clipboard transitions cleanly to failed without throwing.
  setClipboard(undefined);
  const missingView = mount(
    copyButton,
    { value: "agentrun-missing" },
    '<root><trigger as="button">Copy</trigger><fallback>Failed</fallback></root>'
  );
  try {
    expect(await missingView.api.copy()).toBe(false);
    expect(missingView.state.status).toBe("failed");
    expect(missingView.part("fallback")?.isConnected).toBe(true);
  } finally {
    missingView.unmount();
  }
});

test("changing value resets state, cancels pending reset, and invalidates in-flight copy", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn<() => Promise<void>>().mockResolvedValue();
  setClipboard({ writeText });

  const { rerender } = render(<ValueChangeHarness value="first-id" />);
  const trigger = screen.getByRole("button", { name: "Copy id" });

  await act(async () => {
    fireEvent.click(trigger);
    await flushMicrotasks();
  });
  expect(trigger).toHaveAttribute("data-status", "copied");

  rerender(<ValueChangeHarness value="second-id" />);
  expect(trigger).toHaveAttribute("data-status", "idle");

  // In-flight copy from previous value is ignored if value changes before it settles.
  const staleDeferred = Promise.withResolvers<undefined>();
  writeText.mockImplementationOnce(() => staleDeferred.promise);
  fireEvent.click(trigger);
  rerender(<ValueChangeHarness value="third-id" />);
  await act(async () => {
    staleDeferred.resolve();
    await flushMicrotasks();
  });
  expect(trigger).toHaveAttribute("data-status", "idle");

  // New value copies cleanly and uses the updated text.
  writeText.mockResolvedValueOnce();
  await act(async () => {
    fireEvent.click(trigger);
    await flushMicrotasks();
  });
  expect(writeText).toHaveBeenLastCalledWith("third-id");
  expect(trigger).toHaveAttribute("data-status", "copied");
});

test("EvidenceReference and DecisionId preserve names, titles, polite announcement, and failure fallback", async () => {
  vi.useFakeTimers();
  const writeText = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  setClipboard({ writeText });

  const runId = "agentrun-b6e400b2-1c3d-4e5f-8a9b-0c1d7a6f2b0c";
  render(<EvidenceReference id={runId} kind="Run ID" />);

  const button = screen.getByRole("button", { name: `Copy Run ID ${runId}` });
  expect(button).toHaveAttribute(
    "title",
    `Run ID: ${runId}. Copy it for your agent to open the evidence.`
  );
  // The polite status is in the tree from the start, empty until a copy.
  const status = screen.getByRole("status");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveTextContent("");
  expect(screen.queryByRole("alert")).toBeNull();

  // First click succeeds and says so in the status.
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
  expect(writeText).toHaveBeenCalledWith(runId);
  expect(button).toHaveAttribute("data-copied", "");
  expect(status).toHaveTextContent("Copied");

  // The reset empties it, so the next copy is announced again.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(button).not.toHaveAttribute("data-copied");
  expect(status).toHaveTextContent("");

  // Second click fails and shows visible alert + selectable full id.
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Copy failed; select the id below instead."
  );
  expect(screen.getByText(runId)).toBeVisible();

  // Third click succeeds and clears the failure fallback.
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(button).toHaveAttribute("data-copied", "");

  cleanup();

  const decisionId = "pending-2ca483b9-83b0-442f-8461-46aaf28c12e2";
  const decisionWrite = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("blocked"));
  setClipboard({ writeText: decisionWrite });

  render(<DecisionId id={decisionId} />);
  const decisionButton = screen.getByRole("button", {
    name: `Copy decision id ${decisionId}`,
  });
  expect(decisionButton).toHaveAttribute("title", decisionId);
  await act(async () => {
    fireEvent.click(decisionButton);
    await flushMicrotasks();
  });
  expect(decisionWrite).toHaveBeenCalledWith(decisionId);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Copy failed; select the id below instead."
  );
  expect(screen.getByText(decisionId)).toBeVisible();
});

test("RunVideoPlayer Copy video path preserves name, live state labels, and reset", async () => {
  vi.useFakeTimers();
  const writeText = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  setClipboard({ writeText });

  render(
    <RunVideoPlayer
      className={undefined}
      condensed
      path="/runs/agentrun-one/run.webm"
      src="/agent-runs/agentrun-one/video"
      timeMap={undefined}
      timeline={[]}
      videoClassName={undefined}
    />
  );

  const button = screen.getByRole("button", { name: "Copy video path" });
  expect(button).toHaveTextContent("Copy path");

  // The label is a polite live region, as before.
  const label = screen.getByText("Copy path");
  expect(label).toHaveAttribute("aria-live", "polite");

  // Failure updates the label to Couldn't copy.
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
  expect(label).toHaveTextContent("Couldn't copy");
  expect(button).toHaveAttribute("data-failed", "");

  // Retry succeeds, swaps to Copied, and resets after 2000ms.
  await act(async () => {
    fireEvent.click(button);
    await flushMicrotasks();
  });
  expect(label).toHaveTextContent("Copied");
  expect(button).toHaveAttribute("data-copied", "");
  expect(button).not.toHaveAttribute("data-failed");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(button).toHaveTextContent("Copy path");
  expect(button).not.toHaveAttribute("data-copied");
});

test("CopyButton facade works with custom fallback slot", async () => {
  vi.useFakeTimers();
  setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("no")) });

  render(
    <CopyButton value="secret-id">
      <CopyButtonTrigger aria-label="Copy secret">Copy</CopyButtonTrigger>
      <CopyButtonFallback message="Copy failed; select manually." />
    </CopyButton>
  );

  const trigger = screen.getByRole("button", { name: "Copy secret" });
  expect(trigger).toHaveAttribute("data-slot", "copy-button-trigger");
  expect(screen.queryByRole("alert")).toBeNull();

  await act(async () => {
    fireEvent.click(trigger);
    await flushMicrotasks();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Copy failed; select manually."
  );
  expect(screen.getByText("secret-id")).toBeVisible();
});
