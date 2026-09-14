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
import { EvidenceHash } from "@contingency/protocol";
import { Effect, Exit, Ref, Scope, Stream } from "effect";
import type { FileSystem } from "effect";

import type { Demonstration } from "./agent-flow-compiler.ts";
import type { CreateBrowserService } from "./create-browser-contract.ts";
import { browserFailure } from "./create-browser-session.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";
import { makeTeachingEncoder } from "./teaching-encoder.ts";

const EVENT_FILE = "events.jsonl";
const TRACE_FILE = "trace.zip";
const VIDEO_FILE = "recording.webm";
const CHANGE_SUMMARY_LIMIT = 40;

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
  readonly browserSessionId: Parameters<CreateBrowserService["stream"]>[0];
  readonly directory: string;
  readonly emulation: DraftEmulation;
  readonly fileSystem: FileSystem.FileSystem;
  readonly limits?: TeachingCaptureLimits;
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

const summaries = (
  left: AgentBrowserSnapshot | undefined,
  right: AgentBrowserSnapshot | undefined
) => {
  const existing = new Set(
    (left?.nodes ?? []).map((node) => `${node.role}\n${node.name}`)
  );
  return (right?.nodes ?? [])
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

const eventsFor = (
  demonstration: Demonstration,
  emulation: DraftEmulation,
  startedAt: string,
  stoppedAt: string,
  reason: TeachingStopReason,
  detail: string | undefined
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
      hash: EvidenceHash.make(screenshot.contentHash),
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

    let stopped = false;
    return {
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
            encoderFailure ??
            (duration > limits.durationMs
              ? "Teaching stopped because the recording reached its duration limit."
              : ((yield* Ref.get(failure)) ?? undefined));
          const events = eventsFor(
            demonstration,
            options.emulation,
            options.startedAt,
            stoppedAt,
            captureFailure === undefined ? reason : "capture-failed",
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
