import type { PlatformIdentity } from "@contingency/protocol";
import { Clock, Duration, Effect, Metric } from "effect";

/**
 * Process metrics exported over OTLP under the telemetry opt-in. Each metric
 * uses only share-safe low-cardinality attributes (platform, operation,
 * outcome, code, repaired).
 */

export type McpCallOutcome = "succeeded" | "failed" | "intervention";

/** Action duration in milliseconds at the Platform Runtime interface, by platform. */
export const actionDurationMetric = Metric.timer(
  "contingency.action.duration",
  {
    description:
      "Platform Runtime action duration in milliseconds, by platform.",
  }
);

/** Native Capture Gaps, split by whether they were repaired. */
export const captureGapsMetric = Metric.counter("contingency.capture.gaps", {
  description: "Native Capture Gaps, split by whether they were repaired.",
  incremental: true,
});

/** Pursuit outcomes by ending (or `failed` when a Pursuit errors). */
export const pursuitOutcomesMetric = Metric.counter(
  "contingency.pursuit.outcomes",
  {
    description: "Pursuit outcomes by ending.",
    incremental: true,
  }
);

/** MCP operation calls by operation name and outcome. */
export const mcpCallsMetric = Metric.counter("contingency.mcp.calls", {
  description: "MCP operation calls by operation name and outcome.",
  incremental: true,
});

/** Failure References recorded by failure code. */
export const failureReferencesMetric = Metric.counter(
  "contingency.failure.references",
  {
    description: "Failure References recorded by failure code.",
    incremental: true,
  }
);

/** Times one Platform Runtime action and records its duration under `platform`. */
export const recordActionDuration =
  (platform: PlatformIdentity) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* timePlatformAction() {
      const started = yield* Clock.currentTimeNanos;
      return yield* effect.pipe(
        Effect.onExit(() =>
          Clock.currentTimeNanos.pipe(
            Effect.flatMap((ended) =>
              Metric.update(
                Metric.withAttributes(actionDurationMetric, { platform }),
                Duration.nanos(ended >= started ? ended - started : 0n)
              )
            )
          )
        )
      );
    });

/** Records one or more Capture Gaps, split by whether they were repaired. */
export const recordCaptureGap = (
  repaired: boolean,
  count = 1
): Effect.Effect<void> =>
  count <= 0
    ? Effect.void
    : Metric.update(
        Metric.withAttributes(captureGapsMetric, {
          repaired: repaired ? "true" : "false",
        }),
        count
      );

/** Records one Pursuit ending (or `"failed"` when a Pursuit fails). */
export const recordPursuitOutcome = (outcome: string): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(pursuitOutcomesMetric, { outcome }), 1);

/** Records one MCP operation call by operation name and outcome. */
export const recordMcpCall = (
  operation: string,
  outcome: McpCallOutcome
): Effect.Effect<void> =>
  Metric.update(
    Metric.withAttributes(mcpCallsMetric, { operation, outcome }),
    1
  );

/** Records one Failure Reference by its failure code. */
export const recordFailureReference = (code: string): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(failureReferencesMetric, { code }), 1);
