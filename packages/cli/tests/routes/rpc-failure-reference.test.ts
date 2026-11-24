import { AgentSessionId, ContingencyRpcs } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import type { LogLevel } from "effect";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import type { AndroidWorkspaceService } from "../../src/services/android-workspace.ts";
import {
  FailureReferences,
  makeFailureReferenceStore,
} from "../../src/services/failure-reference.ts";
import { makeObservabilityLayer } from "../../src/services/observability.ts";

const SECRET = "hunter2";

const workspace = (
  overrides: Partial<AndroidWorkspaceService>
): AndroidWorkspaceService => ({
  activeRunFlowNames: () => Effect.succeed([]),
  execute: () => Effect.die("Not requested."),
  forward: () => Effect.void,
  keyframes: () => Effect.succeed(null),
  list: () => Effect.succeed([]),
  stream: () => Effect.succeed(null),
  video: () => Effect.succeed(null),
  ...overrides,
});

/** A Workspace client whose server's terminal shows `level`. */
const client = (level: LogLevel.LogLevel, service: AndroidWorkspaceService) =>
  RpcTest.makeClient(ContingencyRpcs, { flatten: true }).pipe(
    Effect.provide(
      RpcHandlersLive.pipe(
        Layer.provide(Layer.succeed(AndroidWorkspace, service)),
        Layer.provide(
          makeObservabilityLayer({
            colors: false,
            home: "/Users/someone",
            level,
            logFile: false,
            now: new Date("2026-11-24T12:00:00.000Z"),
            pid: 42,
            writeTerminal: () => {},
          }).pipe(Layer.provide(NodeServices.layer))
        )
      )
    )
  );

const defective = workspace({
  list: () => Effect.die(new Error(`the page said ${SECRET}`)),
});

it.effect(
  "a defect fails only its request, with a Failure Reference and no cause",
  () =>
    Effect.gen(function* defect() {
      const rpc = yield* client("Warn", defective);
      const failure = yield* Effect.flip(rpc("android.workspace.list", {}));
      expect(failure).toMatchObject({
        _tag: "BrowserRpcError",
        code: "internal_failure",
        failureReference: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{6}$/u),
      });
      expect(JSON.stringify(failure)).not.toContain(SECRET);
      // The client still answers its other requests.
      expect(yield* rpc("ios.workspace.enabled", {})).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

it.effect.each(["Debug", "Warn"] as const)(
  "the Workspace reads a reference's cause only under debug (%s)",
  (level) =>
    Effect.gen(function* detail() {
      const rpc = yield* client(level, defective);
      const failure = yield* Effect.flip(rpc("android.workspace.list", {}));
      const { detail: cause } = yield* rpc("failure.detail.get", {
        failureReference: failure.failureReference ?? "",
      });
      if (level === "Debug") {
        expect(cause).toContain(SECRET);
      } else {
        expect(cause).toBeNull();
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);

it.effect("a native failure keeps its Failure Reference", () =>
  Effect.gen(function* referenced() {
    const rpc = yield* client(
      "Warn",
      workspace({
        execute: () =>
          Effect.fail({
            code: "runtime_failed",
            failureReference: "7KQ2MZ",
            message: "The Android backend failed.",
          }),
      })
    );
    const failure = yield* Effect.flip(
      rpc("android.workspace.command", {
        _tag: "read",
        sessionId: AgentSessionId.make("agent-android-1"),
      })
    );
    expect(failure).toEqual({
      _tag: "BrowserRpcError",
      code: "agent_session_unavailable",
      failureReference: "7KQ2MZ",
      message: "The Android backend failed.",
    });
  }).pipe(Effect.scoped)
);
