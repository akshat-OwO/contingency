import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { DockState } from "@/components/agent/workspace-dock";

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

test("an attention dock state is the needs-you chip behind the alert icon", () => {
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

test("a default dock state is a muted chip with no icon", () => {
  render(<DockState>No session</DockState>);
  const state = screen.getByText("No session");
  expect(state.querySelector("svg")).toBeNull();
  expect(state).toHaveClass(
    "status-chip",
    "[--status-tone:var(--muted-foreground)]"
  );
});
