import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { DockState } from "@/components/agent/workspace-dock";

afterEach(cleanup);

test("a failed dock state is destructive text behind the alert icon", () => {
  render(<DockState tone="failed">Recording failed</DockState>);
  const state = screen.getByText("Recording failed");
  expect(state).toHaveClass("text-destructive");
  expect(state.querySelector("svg")).not.toBeNull();
});

test("an attention dock state is amber text behind the alert icon", () => {
  render(<DockState tone="attention">Needs you</DockState>);
  const state = screen.getByText("Needs you");
  expect(state).toHaveClass("text-amber-600");
  expect(state.querySelector("svg")).not.toBeNull();
});

test("a recording dock state keeps the red recording dot", () => {
  render(<DockState tone="recording">Recording</DockState>);
  expect(screen.getByText("Recording").querySelector("svg")).toHaveClass(
    "text-red-500"
  );
});

test("a default dock state is plain text with no icon and no pill", () => {
  render(<DockState>No session</DockState>);
  const state = screen.getByText("No session");
  expect(state.querySelector("svg")).toBeNull();
  expect(state.className).not.toMatch(/rounded-full|border|bg-/u);
});
