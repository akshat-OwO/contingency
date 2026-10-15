import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import {
  androidIntervention,
  newBrowserWaits,
} from "../../src/services/mcp-code-interpreter.ts";
import type { SessionWaits } from "../../src/services/mcp-code-interpreter.ts";

const idle: SessionWaits = {
  controller: "agent",
  dryRun: null,
  pendingDecisions: [],
  setupVariables: [],
  takeover: null,
};

const dryRunWithSecret = (supplied: boolean): SessionWaits => ({
  ...idle,
  dryRun: {
    flowSkillName: FlowSkillName.make("checkout"),
    inputs: [],
    recordingId: TeachingRecordingId.make("recording-checkout"),
    startedAt: "2026-10-15T00:00:00.000Z",
    variables: [{ name: "PASSWORD", runtime: true, secret: true, supplied }],
  },
});

describe("browser interventions", () => {
  it("ends a program that replaces a supplied Dry Run secret", () => {
    expect([
      ...newBrowserWaits(
        Option.some(dryRunWithSecret(true)),
        dryRunWithSecret(false)
      ),
    ]).toEqual(["variable_requested"]);
  });

  it("does not stop again for a secret that was already awaited", () => {
    expect(
      newBrowserWaits(
        Option.some(dryRunWithSecret(false)),
        dryRunWithSecret(false)
      ).size
    ).toBe(0);
  });
});

const sessionId = AgentSessionId.make("agent-android-1");

const androidSession = (overrides: {
  readonly phase: "pending" | "running";
  readonly variables?: readonly {
    readonly name: string;
    readonly status: "requested" | "supplied";
  }[];
}) => ({
  controller: "agent",
  id: sessionId,
  phase: overrides.phase,
  preparation: { pending: [] },
  variables: overrides.variables ?? [],
});

const start = {
  command: {
    _tag: "start",
    flowSkillName: "checkout",
    kind: "run",
    operationId: OperationId.make("android-start"),
  },
};

describe("Android interventions", () => {
  it("ends a program at a start that needs preparation and private inputs", () => {
    const intervention = androidIntervention(
      start,
      androidSession({
        phase: "pending",
        variables: [{ name: "PIN", status: "requested" }],
      }),
      Option.none()
    );
    expect(intervention?.reasons.toSorted()).toEqual([
      "device_preparation",
      "variable_requested",
    ]);
    expect(intervention?.sessionId).toBe(sessionId);
  });

  it("lets a running session continue when nothing new waits on the user", () => {
    expect(
      androidIntervention(
        { command: { _tag: "observe", sessionId } },
        androidSession({
          phase: "running",
          variables: [{ name: "PIN", status: "requested" }],
        }),
        Option.some({
          controller: "agent",
          phase: "running",
          preparation: {
            differences: [],
            evidence: [],
            pending: [],
            phase: "ready",
          },
        })
      )
    ).toBeUndefined();
  });
});
