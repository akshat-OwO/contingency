import {
  makeBrowserRpcError,
  RpcFailures,
  withFailureReference,
} from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Cause, Effect, Layer, LogLevel, Option, Schema } from "effect";

import { childOutputsOf } from "./child-process.ts";
import { lookupFailure, recordFailure } from "./failure-reference.ts";
import type { FailureReference } from "./failure-reference.ts";
import { Observability } from "./observability.ts";

/**
 * Where a failure leaves Contingency: the Workspace's RPC and an agent's MCP
 * call. Each seam keeps the code and the fixed message, names the Failure
 * Reference when the code does not state the cause, and never sends the
 * cause itself ([ADR 0089](../../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 */

/** A failure a service raised, which may name a recorded cause. */
export interface ReferencedFailure {
  readonly message: string;
  readonly failureReference?: FailureReference | null | undefined;
}

/** What the Workspace reads for a service failure. */
export const rpcFailure = (
  code: BrowserRpcErrorType["code"],
  failure: ReferencedFailure,
  message = failure.message
): BrowserRpcErrorType =>
  withFailureReference(
    makeBrowserRpcError(code, message),
    failure.failureReference
  );

export const INTERNAL_FAILURE_MESSAGE =
  "Contingency failed unexpectedly. Report the Failure Reference with the Diagnostic Log.";

/** Records a defect and answers with its reference instead. */
export const internalFailure = (
  cause: Cause.Cause<unknown>
): Effect.Effect<BrowserRpcErrorType> =>
  recordFailure(cause, "internal_failure").pipe(
    Effect.map((reference) =>
      withFailureReference(
        makeBrowserRpcError("internal_failure", INTERNAL_FAILURE_MESSAGE),
        reference
      )
    )
  );

const isDefect = (cause: Cause.Cause<unknown>) =>
  Cause.hasDies(cause) && !Cause.hasInterrupts(cause);

/** The session or Run an RPC names, for the record a defect writes. */
const decodePayloadIds = Schema.decodeUnknownOption(
  Schema.Struct({
    runId: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
  })
);

/**
 * A defect fails its own request with a reference. Effect's RPC server would
 * otherwise send it as a client-wide defect, failing every request in flight.
 */
export const RpcFailuresLive = Layer.succeed(
  RpcFailures,
  (effect, { payload, rpc }) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        isDefect(cause)
          ? internalFailure(cause).pipe(
              Effect.annotateLogs({
                rpc: rpc._tag,
                ...Option.getOrElse(decodePayloadIds(payload), () => ({})),
              }),
              Effect.flatMap(Effect.fail)
            )
          : Effect.failCause(cause)
      )
    )
);

/** A cause as the Workspace shows it: the cause, then each failed child's output tail. */
const describeCause = (cause: Cause.Cause<unknown>): string =>
  [
    Cause.pretty(cause),
    ...childOutputsOf(cause).flatMap(({ child, output }) => [
      `${child} stderr, last bytes:\n${output.stderr || "(empty)"}`,
      ...(output.stdout === undefined || output.stdout === ""
        ? []
        : [`${child} stdout, last bytes:\n${output.stdout}`]),
    ]),
  ].join("\n\n");

/**
 * The recorded cause for the Workspace, only while the terminal shows debug.
 * The Workspace is the user's own view; MCP never reads this.
 */
export const failureDetail = (
  reference: FailureReference
): Effect.Effect<{ readonly detail: string | null }> =>
  Effect.gen(function* readFailureDetail() {
    const observability = yield* Effect.serviceOption(Observability);
    if (Option.isNone(observability)) {
      return { detail: null };
    }
    const level = yield* observability.value.terminalLevel;
    if (!LogLevel.isLessThanOrEqualTo(level, "Debug")) {
      return { detail: null };
    }
    const cause = yield* lookupFailure(reference);
    return { detail: Option.isSome(cause) ? describeCause(cause.value) : null };
  });

/** An MCP failure: its code, its fixed message, and its reference if any. */
export const mcpFailure = (failure: {
  readonly code: string;
  readonly message: string;
  readonly failureReference?: FailureReference | null | undefined;
}) =>
  failure.failureReference === null || failure.failureReference === undefined
    ? { code: failure.code, message: failure.message }
    : {
        code: failure.code,
        failureReference: failure.failureReference,
        message: failure.message,
      };

/** A failure's message for an agent, naming the reference when there is one. */
export const mcpFailureText = (
  message: string,
  failureReference: FailureReference | null | undefined
): string =>
  failureReference === null || failureReference === undefined
    ? message
    : `${message} (failureReference ${failureReference})`;
