import { SessionId } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import { browserInputIsReadOnly } from "../../src/routes/rpc";

const sessionId = SessionId.make("create-session-1");

const snapshotWithPhase = (
  phase: "active" | "finished" | "incomplete" | "paused"
) =>
  ({
    captureMode: "ordinary",
    phase,
    sessionId,
  }) as const;

describe("browser input guard", () => {
  it("rejects input after a single-tab Recording becomes incomplete", () => {
    expect(
      browserInputIsReadOnly(snapshotWithPhase("incomplete"), sessionId)
    ).toBe(true);
  });
});
