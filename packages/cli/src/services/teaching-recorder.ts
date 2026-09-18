import path from "node:path";

import type {
  AgentBrowserSnapshot,
  BrowserRpcErrorType,
  DraftEmulation,
  TeachingCaptureLimits,
  TeachingEvent,
  TeachingEventTarget,
  TeachingStopReason,
} from "@contingency/protocol";
import { ContentHash } from "@contingency/protocol";
import { Deferred, Effect, Exit, Ref, Scope, Stream } from "effect";
import type { FileSystem } from "effect";

import type { CreateBrowserService } from "./create-browser-contract.ts";
import { browserFailure } from "./create-browser-session.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import type { DemonstrationCounts } from "./teaching-capture.ts";
import type { Demonstration } from "./teaching-demonstration.ts";
import { makeTeachingEncoder } from "./teaching-encoder.ts";

const EVENT_FILE = "events.jsonl";
const TRACE_FILE = "trace.zip";
const VIDEO_FILE = "recording.webm";
const CHANGE_SUMMARY_LIMIT = 40;

/**
 * How often the capture watchdog tests the ceilings. A ceiling ends the
 * recording on its own, so the reader never waits on a Stop gesture that may
 * never come; one second is far below every ceiling's own granularity.
 */
const WATCHDOG_INTERVAL_MS = 1000;

/**
 * How many new events may accumulate before the watchdog re-serializes the
 * stream to measure it. Between measurements the size is projected from the
 * measured bytes-per-event, so the common tick stays O(1) and the O(n) measure
 * only runs as the stream approaches its ceiling.
 */
const EVENT_BYTES_RECHECK_EVENTS = 64;

export const DEFAULT_TEACHING_CAPTURE_LIMITS: TeachingCaptureLimits = {
  durationMs: 60 * 60 * 1000,
  eventBytes: 16 * 1024 * 1024,
  events: 10_000,
  keyframes: 400,
  videoBytes: 1024 * 1024 * 1024,
};

export interface TeachingRecorderResult {
  readonly failure: string | undefined;
  readonly traceFile: string;
  readonly videoFile: string;
}

export interface TeachingRecorder {
  /**
   * Completes with the reader-facing detail once a capture ceiling ends the
   * recording. The Agent Session awaits this and drives the session out of
   * `recording` itself, because only the session owns that state machine.
   */
  readonly limitReached: Effect.Effect<string>;
  readonly stop: (
    demonstration: Demonstration,
    reason: TeachingStopReason,
    stoppedAt: string
  ) => Effect.Effect<TeachingRecorderResult>;
  readonly traceFile: string;
  readonly videoFile: string;
}

export interface TeachingRecorderOptions {
  readonly browser: CreateBrowserService;
  /** O(1) capture sizes, read by the watchdog on every tick. */
  readonly counts: () => DemonstrationCounts;
  /** The capture so far, serialized only when the byte ceiling is near. */
  readonly demonstration: () => Demonstration;
  readonly browserSessionId: Parameters<CreateBrowserService["stream"]>[0];
  readonly directory: string;
  readonly emulation: DraftEmulation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly limits?: TeachingCaptureLimits | undefined;
  readonly startedAt: string;
}

const observation = (
  snapshot: AgentBrowserSnapshot | undefined,
  fallbackUrl: string
) => ({
  nodeCount: snapshot?.nodes.length ?? 0,
  title: snapshot?.title ?? "",
  url: snapshot?.url ?? fallbackUrl,
});

const targetFor = (
  snapshot: AgentBrowserSnapshot | undefined,
  ref: string | undefined
): TeachingEventTarget | null => {
  if (snapshot === undefined || ref === undefined) {
    return null;
  }
  const index = snapshot.nodes.findIndex((node) => node.ref === ref);
  const node = snapshot.nodes[index];
  if (node === undefined) {
    return null;
  }
  const context: string[] = [];
  let { depth } = node;
  for (let cursor = index - 1; cursor >= 0 && depth > 0; cursor -= 1) {
    const ancestor = snapshot.nodes[cursor];
    if (ancestor !== undefined && ancestor.depth < depth) {
      const { depth: ancestorDepth, name } = ancestor;
      if (name.trim().length > 0) {
        context.unshift(name);
      }
      depth = ancestorDepth;
    }
  }
  return {
    checked: node.checked ?? null,
    context,
    disabled: node.disabled ?? null,
    name: node.name,
    role: node.role,
    value: node.value ?? null,
    valueWithheld: node.valueWithheld ?? null,
  };
};

/**
 * What one side of the diff gained over the other. A missing or empty tree is
 * an absent observation, not an empty Page: an action whose after state was
 * never captured must not read as though every node on the Page vanished.
 */
const summaries = (
  left: AgentBrowserSnapshot | undefined,
  right: AgentBrowserSnapshot | undefined
) => {
  if (
    left === undefined ||
    right === undefined ||
    left.nodes.length === 0 ||
    right.nodes.length === 0
  ) {
    return [];
  }
  const existing = new Set(
    left.nodes.map((node) => `${node.role}\n${node.name}`)
  );
  return right.nodes
    .filter((node) => !existing.has(`${node.role}\n${node.name}`))
    .slice(0, CHANGE_SUMMARY_LIMIT)
    .map(({ name, role }) => ({ name, role }));
};

type TeachingEventWithoutSequence = TeachingEvent extends infer Event
  ? Event extends TeachingEvent
    ? Omit<Event, "seq">
    : never
  : never;

// SAFETY: every pending entry is one TeachingEvent variant with only the
// sequence omitted; adding the non-negative array index completes it.
const withSequence = (
  event: TeachingEventWithoutSequence,
  seq: number
): TeachingEvent => ({ ...event, seq }) as TeachingEvent;

const measureEventBytes = (events: readonly TeachingEvent[]): number =>
  Buffer.byteLength(
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf-8"
  );

/**
 * The semantic timeline one Demonstration becomes, in capture order. Pure, so
 * the evidence a learning agent will trust can be asserted on directly.
 */
export const teachingEventsFor = (
  demonstration: Demonstration,
  emulation: DraftEmulation,
  startedAt: string,
  stoppedAt: string,
  reason: TeachingStopReason,
  detail?: string
): readonly TeachingEvent[] => {
  const pending: TeachingEventWithoutSequence[] = [
    {
      _tag: "started",
      at: startedAt,
      emulation,
      url:
        demonstration.urlTransitions[0]?.from ??
        demonstration.actions[0]?.urlBefore ??
        "about:blank",
    },
  ];
  for (const transition of demonstration.urlTransitions) {
    pending.push({
      _tag: "url",
      at: transition.at,
      from: transition.from,
      url: transition.to,
    });
  }
  for (const instruction of demonstration.instructions) {
    pending.push({
      _tag: "instruction",
      at: instruction.at,
      text: instruction.text,
    });
  }
  for (const action of demonstration.actions) {
    const before =
      action.snapshotBefore === null
        ? undefined
        : demonstration.snapshots.get(action.snapshotBefore);
    const after =
      action.snapshotAfter === null
        ? undefined
        : demonstration.snapshots.get(action.snapshotAfter);
    const ref = "ref" in action.action ? action.action.ref : undefined;
    pending.push({
      _tag: "action",
      after: observation(after, action.urlAfter),
      appeared: summaries(before, after),
      at: action.at,
      before: observation(before, action.urlBefore),
      description: action.description,
      detail: action.detail ?? null,
      disappeared: summaries(after, before),
      id: action.id,
      kind: action.action.type,
      outcome: action.outcome === "completed" ? "succeeded" : "failed",
      target: targetFor(before ?? after, ref),
    });
  }
  for (const screenshot of demonstration.screenshots) {
    pending.push({
      _tag: "keyframe",
      actionId: null,
      at: screenshot.capturedAt,
      hash: ContentHash.make(screenshot.contentHash),
      path: `${screenshot.id}.png`,
    });
  }
  pending.sort((left, right) => left.at.localeCompare(right.at));
  pending.push({
    _tag: "stopped",
    at: stoppedAt,
    detail: detail ?? null,
    reason,
  });
  return pending.map(withSequence);
};

export const makeTeachingRecorder = (
  options: TeachingRecorderOptions
): Effect.Effect<TeachingRecorder, BrowserRpcErrorType, Scope.Scope> =>
  Effect.gen(function* startTeachingRecorder() {
    const { fileSystem } = options;
    const limits = options.limits ?? DEFAULT_TEACHING_CAPTURE_LIMITS;
    const traceFile = path.join(options.directory, TRACE_FILE);
    const videoFile = path.join(options.directory, VIDEO_FILE);
    const eventFile = path.join(options.directory, EVENT_FILE);
    const target = yield* options.browser.activeTarget(
      options.browserSessionId
    );
    yield* fileSystem
      .writeFileString(
        eventFile,
        `${JSON.stringify({
          _tag: "started",
          at: options.startedAt,
          emulation: options.emulation,
          seq: 0,
          url: sanitizeTeachingUrl(target.page.url()),
        } satisfies TeachingEvent)}\n`
      )
      .pipe(
        Effect.mapError((cause) =>
          browserFailure("Could not start the Teaching event stream", cause)
        )
      );
    const failure = yield* Ref.make<string | null>(null);
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: (cause) =>
          browserFailure("Could not start the Teaching Trace", cause),
        try: () =>
          target.context.tracing.start({ screenshots: true, snapshots: true }),
      }),
      () =>
        Effect.tryPromise({
          catch: () => null,
          try: () => target.context.tracing.stop({ path: traceFile }),
        }).pipe(Effect.ignore)
    );
    const encoder = yield* makeTeachingEncoder({
      maxBytes: limits.videoBytes,
      output: videoFile,
    });
    const scope = yield* Effect.scope;
    yield* options.browser.stream(options.browserSessionId).pipe(
      Stream.runForEach((event) => {
        if (event.type !== "frame") {
          return Effect.void;
        }
        return encoder
          .write(event.data)
          .pipe(
            Effect.andThen(
              options.browser
                .acknowledgeFrame(
                  options.browserSessionId,
                  event.seq,
                  event.streamId
                )
                .pipe(Effect.ignore)
            )
          );
      }),
      Effect.tapError((cause) =>
        Ref.set(failure, `Teaching capture stopped: ${cause.message}`)
      ),
      Effect.ignore,
      Effect.forkIn(scope)
    );

    // A ceiling is documented to end the recording, not merely to truncate the
    // artifact at Stop. The watchdog trips `breach`, the loop exits, and the
    // Agent Session -- which owns `captureState` -- reacts to `limitReached`.
    const limitReached = yield* Deferred.make<string>();
    let breach: string | undefined;
    let measuredBytes = 0;
    let measuredEvents = 0;
    const exceededCeiling = (): string | undefined => {
      const encoderFailure = encoder.unsafeFailure();
      if (encoderFailure !== undefined) {
        return encoderFailure;
      }
      if (Date.now() - Date.parse(options.startedAt) > limits.durationMs) {
        return "Teaching stopped because the recording reached its duration limit.";
      }
      const counts = options.counts();
      if (counts.keyframes > limits.keyframes) {
        return "Teaching stopped because the recording reached its keyframe limit.";
      }
      // Mirrors `teachingEventsFor`: one `started`, one per captured entry, one
      // `stopped`.
      const events =
        2 +
        counts.actions +
        counts.instructions +
        counts.keyframes +
        counts.urlTransitions;
      if (events > limits.events) {
        return "Teaching stopped because the recording reached its event limit.";
      }
      const perEvent =
        measuredEvents === 0 ? 0 : measuredBytes / measuredEvents;
      const projected = measuredBytes + perEvent * (events - measuredEvents);
      if (
        measuredEvents !== 0 &&
        events - measuredEvents < EVENT_BYTES_RECHECK_EVENTS &&
        projected < limits.eventBytes
      ) {
        return;
      }
      measuredBytes = measureEventBytes(
        teachingEventsFor(
          options.demonstration(),
          options.emulation,
          options.startedAt,
          new Date().toISOString(),
          "limit-reached"
        )
      );
      measuredEvents = events;
      return measuredBytes > limits.eventBytes
        ? "Teaching stopped because the event stream reached its size limit."
        : undefined;
    };
    yield* Effect.whileLoop({
      body: () =>
        Effect.sleep(WATCHDOG_INTERVAL_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              breach = exceededCeiling();
            })
          )
        ),
      step: () => {
        // The loop condition reads `breach` directly.
      },
      while: () => breach === undefined,
    }).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          breach === undefined
            ? Effect.void
            : Deferred.succeed(limitReached, breach).pipe(Effect.asVoid)
        )
      ),
      Effect.forkIn(scope)
    );

    let stopped = false;
    return {
      limitReached: Deferred.await(limitReached),
      stop: (demonstration, reason, stoppedAt) =>
        Effect.gen(function* stopTeachingRecorder() {
          if (stopped) {
            return {
              failure: (yield* Ref.get(failure)) ?? undefined,
              traceFile,
              videoFile,
            };
          }
          stopped = true;
          yield* Scope.close(scope, Exit.void);
          const encoderFailure = yield* encoder.failure;
          const duration =
            Date.parse(stoppedAt) - Date.parse(options.startedAt);
          let captureFailure =
            breach ??
            encoderFailure ??
            (duration > limits.durationMs
              ? "Teaching stopped because the recording reached its duration limit."
              : ((yield* Ref.get(failure)) ?? undefined));
          const failureReason: TeachingStopReason =
            breach === undefined ? "capture-failed" : "limit-reached";
          const stopReason =
            captureFailure === undefined ? reason : failureReason;
          const events = teachingEventsFor(
            demonstration,
            options.emulation,
            options.startedAt,
            stoppedAt,
            stopReason,
            captureFailure
          );
          let boundedEvents = events.slice(1);
          if (events.length > limits.events) {
            captureFailure =
              "Teaching stopped because the recording reached its event limit.";
            const stoppedEvent = events.at(-1);
            if (stoppedEvent?._tag === "stopped") {
              boundedEvents = [
                ...events.slice(1, limits.events - 1),
                {
                  ...stoppedEvent,
                  detail: captureFailure,
                  reason: "limit-reached",
                  seq: limits.events - 1,
                },
              ];
            }
          }
          let contents = boundedEvents
            .map((event) => JSON.stringify(event))
            .join("\n");
          contents = `${contents}\n`;
          if (Buffer.byteLength(contents, "utf-8") > limits.eventBytes) {
            captureFailure =
              "Teaching stopped because the event stream reached its size limit.";
            contents = `${JSON.stringify({
              _tag: "stopped",
              at: stoppedAt,
              detail: captureFailure,
              reason: "limit-reached",
              seq: 1,
            } satisfies TeachingEvent)}\n`;
          }
          yield* fileSystem
            .writeFileString(eventFile, contents, { flag: "a" })
            .pipe(Effect.ignore);
          for (const screenshot of demonstration.screenshots.slice(
            0,
            limits.keyframes
          )) {
            const content = demonstration.screenshotContents.get(
              screenshot.contentHash
            );
            if (content !== undefined) {
              yield* fileSystem
                .writeFile(
                  path.join(options.directory, `${screenshot.id}.png`),
                  Buffer.from(content.image, "base64")
                )
                .pipe(Effect.ignore);
            }
          }
          return { failure: captureFailure, traceFile, videoFile };
        }),
      traceFile,
      videoFile,
    };
  });
