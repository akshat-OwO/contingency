import { TaskAgentRunSummary } from "@contingency/protocol";
import { Schema } from "effect";

/** Two skills use the same input name with different values in one task. */
export const taskRunSummary = Schema.decodeUnknownSync(TaskAgentRunSummary)({
  assessment: {
    evidence: [{ id: "snapshot-cart", kind: "snapshot" }],
    explanation:
      "The requested cart contains the mug; checkout was not requested.",
    outcome: "working",
    submittedAt: "2026-10-01T00:02:00.000Z",
  },
  attribution: {
    clientName: "test-agent",
    clientVersion: "1.0.0",
    reportedMetadataVerified: false,
    reportedModel: null,
    reportedProvider: null,
  },
  endedAt: "2026-10-01T00:03:00.000Z",
  findings: [
    {
      evidence: [{ id: "attempt-cart", kind: "attempt" }],
      explanation:
        "The first add-to-cart attempt failed before a successful retry.",
      id: "finding-cart",
      outcome: "not-working",
      submittedAt: "2026-10-01T00:01:00.000Z",
    },
  ],
  inputs: [
    { flowSkillName: "browse-catalogue", name: "product", value: "Mug" },
    { flowSkillName: "update-cart", name: "product", value: "Blue mug" },
  ],
  instructions: [
    {
      instruction: "Switch to update-cart and stop before checkout.",
      receivedAt: "2026-10-01T00:00:30.000Z",
    },
  ],
  outcome: "completed",
  purpose: { kind: "interactive" },
  referencedSkills: [
    {
      flowSkillName: "browse-catalogue",
      referencedAt: "2026-10-01T00:00:00.000Z",
    },
    { flowSkillName: "update-cart", referencedAt: "2026-10-01T00:00:30.000Z" },
  ],
  requestedTask: "Browse the catalogue and add a mug to the cart.",
  runId: "agentrun-task-store",
  schemaVersion: 3,
  sessionId: "agent-task-store",
  startedAt: "2026-10-01T00:00:00.000Z",
  startingEmulation: {
    permissions: [],
    userAgentProfile: "default",
    viewport: { deviceScaleFactor: 1, height: 900, width: 1440 },
  },
  timeline: [
    {
      actor: "agent",
      at: "2026-10-01T00:00:45.000Z",
      description: "Add mug to cart",
      dispatched: true,
      id: "attempt-cart",
      outcome: "failed",
    },
  ],
  title: "Add a mug without checkout",
  tracePath: "run.trace.zip",
  variables: [
    {
      flowSkillName: "browse-catalogue",
      name: "TOKEN",
      runtime: true,
      secret: true,
      supplied: false,
    },
  ],
  videoPath: "run.webm",
});
