import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import { StepDetail } from "@/components/audit/step-detail";

afterEach(cleanup);

test("renders a bounded Scroll readiness diagnostic as non-failing evidence", () => {
  const step: TimelineStep = {
    findings: [],
    index: 1,
    label: "Scroll document",
    result: {
      finishedAt: "2026-01-01T00:00:01.000Z",
      index: 1,
      outcome: "completed",
      scrollReadiness: {
        pendingRequests: 2,
        unsettled: ["dom-mutations", "finite-requests", "observation-ended"],
        waitDurationMs: 350,
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      type: "scroll",
    },
    state: "done",
    type: "scroll",
  };

  render(<StepDetail step={step} />);

  expect(
    screen.getByRole("heading", {
      name: "Scroll readiness reached its bound",
    })
  ).toBeVisible();
  expect(
    screen.getByText("Continued after 350 ms. This did not fail the Step.")
  ).toBeVisible();
  expect(
    screen.getByText("Requests started by the Scroll were still running (2)")
  ).toBeVisible();
  expect(
    screen.getByText("Readiness observation ended with the previous page")
  ).toBeVisible();
});
