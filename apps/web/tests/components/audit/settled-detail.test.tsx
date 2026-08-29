import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { SettledDetail } from "@/components/audit/settled-detail";

afterEach(cleanup);

test("names the terminal Run settled, never a Step", () => {
  render(
    <SettledDetail
      diagnostic="DOM still mutating after 2000ms"
      finishedAt="2026-01-01T00:00:04.000Z"
      outcome="completed"
    />
  );
  expect(screen.getByRole("heading", { name: "Run settled" })).toBeVisible();
  expect(screen.queryByText(/Step/u)).toBeNull();
  expect(screen.getByText("completed")).toBeVisible();
  expect(screen.getByText("2026-01-01T00:00:04.000Z")).toBeVisible();
  expect(screen.getByText("DOM still mutating after 2000ms")).toBeVisible();
});

test("omits the diagnostic when the attempt recorded none", () => {
  render(
    <SettledDetail finishedAt="2026-01-01T00:00:04.000Z" outcome="failed" />
  );
  expect(screen.getByText("failed")).toBeVisible();
  expect(screen.queryByText(/mutating/u)).toBeNull();
});
