import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
  TeachingRecordingId,
} from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { ExecutionValuesLive } from "../../src/services/execution-values.ts";
import {
  CodeInterpreterToolHandlersLive,
  CodeInterpreterTools,
  InterpreterOperations,
  androidIntervention,
  newBrowserWaits,
} from "../../src/services/mcp-code-interpreter.ts";
import type {
  InterpreterOperationEntry,
  SessionWaits,
} from "../../src/services/mcp-code-interpreter.ts";

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

// One hang guard per test, sized for a hung interpreter rather than the work.
const HANG_GUARD_MS = 60_000;

const browserId = AgentSessionId.make("agent-browser-1");

const takenOver: SessionWaits = {
  ...idle,
  controller: "user",
  takeover: {
    reason: "I will finish this myself.",
    requestedAt: "2026-10-16T00:00:00.000Z",
    requestedBy: "user",
  },
};

/**
 * One session the user changes from inside operations, standing in for a
 * Workspace action that lands while a program waits or between two calls.
 */
const userWorkspace = (initial: SessionWaits, duringRead?: SessionWaits) => {
  let waits = initial;
  const dispatched: string[] = [];
  const operation = (
    name: string,
    readOnly: boolean,
    userActs?: SessionWaits
  ): InterpreterOperationEntry => ({
    description: name,
    inputSchema: {},
    name,
    readOnly,
    run: () =>
      Effect.sync(() => {
        dispatched.push(name);
        if (userActs !== undefined) {
          waits = userActs;
        }
        return { ok: true as const, value: { id: browserId } };
      }),
  });
  const layer = CodeInterpreterToolHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.sync(
          InterpreterOperations,
          () =>
            new Map(
              [
                // What the user does while the program waits on events.
                operation("agent_session_get", true, duringRead),
                // The user takes control between two calls, unobserved.
                operation("agent_sessions_get", true, takenOver),
                operation("agent_session_close", false),
              ].map((entry) => [entry.name, entry])
            )
        ),
        Layer.mock(AgentSession, {
          get: () => {
            // SAFETY: the dispatcher reads only the waits and the view link.
            const session = {
              ...waits,
              viewUrl: "http://127.0.0.1:7783/agent/agent-browser-1",
            } as AgentSessionSnapshot;
            return Effect.succeed(session);
          },
        }),
        ExecutionValuesLive,
        NodeServices.layer
      )
    )
  );
  const execute = (code: string) =>
    Effect.gen(function* executeProgram() {
      const tools = yield* CodeInterpreterTools;
      const results = yield* tools
        .handle("agent_code_execute", { code })
        .pipe(Effect.orDie, Effect.flatMap(Stream.runCollect));
      return results.at(-1)?.result;
    }).pipe(Effect.provide(layer), Effect.timeout(HANG_GUARD_MS));
  return { dispatched, execute };
};

const sessionArgument = JSON.stringify({ sessionId: browserId });

describe("browser interventions during a program", () => {
  it.live(
    "ends at a Takeover that arrives during a read, before a later close",
    () =>
      Effect.gen(function* takeoverDuringRead() {
        const workspace = userWorkspace(idle, takenOver);
        const answer = yield* workspace.execute(`
          await tools.agent_session_get(${sessionArgument});
          await tools.agent_session_close(${sessionArgument});
          return "unreachable";
        `);
        expect(answer).toMatchObject({
          intervention: {
            operation: "agent_session_get",
            reasons: ["takeover", "user_control"],
          },
          receipts: [{ operation: "agent_session_get", outcome: "succeeded" }],
          status: "intervention",
        });
        expect(workspace.dispatched).toEqual(["agent_session_get"]);
      }),
    HANG_GUARD_MS
  );

  it.live(
    "refuses a close after a Takeover that no read observed",
    () =>
      Effect.gen(function* takeoverBetweenCalls() {
        const workspace = userWorkspace(idle);
        const answer = yield* workspace.execute(`
          await tools.agent_session_get(${sessionArgument});
          await tools.agent_sessions_get({});
          await tools.agent_session_close(${sessionArgument});
          return "unreachable";
        `);
        expect(answer).toMatchObject({
          intervention: {
            operation: "agent_session_close",
            reasons: ["takeover", "user_control"],
          },
          receipts: [
            { operation: "agent_session_get", outcome: "succeeded" },
            { operation: "agent_sessions_get", outcome: "succeeded" },
            { operation: "agent_session_close", outcome: "rejected" },
          ],
          status: "intervention",
        });
        expect(workspace.dispatched).toEqual([
          "agent_session_get",
          "agent_sessions_get",
        ]);
      }),
    HANG_GUARD_MS
  );

  it.live(
    "lets a new program read a Takeover that was already waiting",
    () =>
      Effect.gen(function* existingTakeover() {
        const workspace = userWorkspace(takenOver);
        const answer = yield* workspace.execute(`
          await tools.agent_session_get(${sessionArgument});
          return "read";
        `);
        expect(answer).toMatchObject({ status: "completed", value: "read" });
      }),
    HANG_GUARD_MS
  );
});
