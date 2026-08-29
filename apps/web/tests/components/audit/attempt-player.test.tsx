import type { RunSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { AttemptPlayer } from "@/components/audit/attempt-player";

afterEach(cleanup);

const idleRun = {
  attemptCeiling: 4,
  flow: {
    steps: [{ type: "navigate", url: "https://example.com" }],
    title: "T",
  },
  phase: "finished",
  run: { attempts: [], runId: "run-1", steps: [] },
  steps: [],
  trace: null,
  variablePrompt: null,
  video: {
    containsSecrets: false,
    runId: "run-1",
    segments: [
      {
        attempt: 1,
        error: "The Trace did not capture the final settled state.",
        file: "attempt-1.webm",
        includesSettledState: false,
        recorded: false,
        steps: [],
      },
    ],
  },
  warnings: [],
} as unknown as RunSnapshot;

test("keeps the missing settled-state error visible and does not invent a frame", () => {
  render(
    <AttemptPlayer
      attempt={1}
      onPin={vi.fn()}
      run={idleRun}
      selected={{ index: 0, kind: "step" }}
      timeline={[]}
    />
  );
  expect(
    screen.getByText("The Trace did not capture the final settled state.")
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Run settled" })).toBeNull();
  expect(document.querySelector("video")).toBeNull();
});
