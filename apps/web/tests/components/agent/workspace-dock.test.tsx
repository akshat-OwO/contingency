import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";

import { DockState, DockStatus } from "@/components/agent/workspace-dock";

afterEach(cleanup);

test("a failed dock state is a destructive chip behind the alert icon", () => {
  render(<DockState tone="failed">Recording failed</DockState>);
  const state = screen.getByText("Recording failed");
  expect(state).toHaveClass(
    "status-chip",
    "[--status-tone:var(--destructive)]"
  );
  expect(state.querySelector("svg")).not.toBeNull();
});

test("an attention dock state is the needs-you chip behind a hand", () => {
  render(<DockState tone="attention">Needs you</DockState>);
  const state = screen.getByText("Needs you");
  expect(state).toHaveClass("status-chip");
  expect(state).toHaveAttribute("data-status", "needs-you");
  expect(state.querySelector("svg")).not.toBeNull();
});

test("a recording dock state is the recording chip with a still dot", () => {
  render(<DockState tone="recording">Recording</DockState>);
  const state = screen.getByText("Recording");
  expect(state).toHaveAttribute("data-status", "recording");
  expect(state.querySelector(".animate-ping")).toBeNull();
});

test("a busy dock state holds still: a progress ring, never a spinner", () => {
  render(<DockState tone="busy">Agent preparing</DockState>);
  const state = screen.getByText("Agent preparing");
  expect(state).toHaveAttribute("data-status", "running");
  expect(state.querySelector("svg")).not.toBeNull();
  expect(state.querySelector(".animate-spin")).toBeNull();
});

test("an ended dock state is a muted chip behind a stop mark", () => {
  render(<DockState tone="ended">Ended</DockState>);
  const state = screen.getByText("Ended");
  expect(state).toHaveClass(
    "status-chip",
    "[--status-tone:var(--muted-foreground)]"
  );
  expect(state).toHaveAttribute("data-tone", "ended");
});

test("a default dock state is a muted chip with no icon", () => {
  render(<DockState>No session</DockState>);
  const state = screen.getByText("No session");
  expect(state.querySelector("svg")).toBeNull();
  expect(state).toHaveClass(
    "status-chip",
    "[--status-tone:var(--muted-foreground)]"
  );
});

test("the status sentence opens whole in a card above the island", async () => {
  const user = userEvent.setup();
  const sentence =
    "The agent is preparing the browser. Start recording appears when it hands you control; nothing is captured before then.";
  render(
    <DockStatus
      badges={<DockState>Agent preparing</DockState>}
      details={<p>Step 2 of 6</p>}
    >
      {sentence}
    </DockStatus>
  );
  await user.click(within(screen.getByRole("status")).getByRole("button"));
  const card = await screen.findByRole("dialog");
  expect(within(card).getByText(sentence)).toBeInTheDocument();
  expect(within(card).getByText("Step 2 of 6")).toBeInTheDocument();
});
