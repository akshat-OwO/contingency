import { describe, expect, it } from "vitest";

import { browserInputIsReadOnly } from "../../src/routes/rpc";

const snapshotWithPhase = (
  phase: "active" | "finished" | "incomplete" | "paused"
) =>
  ({
    captureMode: "ordinary",
    phase,
    sessionId: "session-1",
  }) as const;

describe("browser input guard", () => {
  it("rejects input after a single-tab Recording becomes incomplete", () => {
    expect(
      browserInputIsReadOnly(snapshotWithPhase("incomplete"), "session-1")
    ).toBe(true);
  });
});
