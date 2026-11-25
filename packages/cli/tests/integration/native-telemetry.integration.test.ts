import {
  AndroidWorkspaceCommand,
  FlowName,
  IosWorkspaceCommand,
  OperationId,
} from "@contingency/protocol";
import type {
  AgentSessionId,
  AndroidWorkspaceSelection,
  IosWorkspaceSelection,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Metric,
  References,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import { AndroidWorkspace } from "../../src/services/android-workspace.ts";
import { REDACTED, toSafeRecord } from "../../src/services/diagnostic-log.ts";
import type { SafeRecord } from "../../src/services/diagnostic-log.ts";
import { recordFailure } from "../../src/services/failure-reference.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { recordPursuitOutcome } from "../../src/services/metrics.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import {
  corpusAndroidSelection,
  corpusIosSelection,
  corpusIosSimulator,
  makeCorpusAndroidWorkspaceLayer,
  makeCorpusIosWorkspaceLayer,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";
import {
  connectMcp,
  operationParams,
  servingMcpHttp,
} from "../helpers/mcp-http.ts";
import { makeRecordingTracer } from "../helpers/recording-tracer.ts";
import type { RecordedSpan } from "../helpers/recording-tracer.ts";

const HOME = "/Users/someone";
const SECRET = "hunter2-secret-value";
/** Shaped like a code, so only its provenance keeps it out of the log. */
const PRIVATE_TOKEN = "agentrun-hunter2-private";
const PRIVATE_SESSION = "agent-hunter2-private";
const op = OperationId.make;

const Answer = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.Boolean,
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});

const DeviceResult = Schema.Struct({
  id: Schema.String,
  observation: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      nodes: Schema.Array(
        Schema.Struct({ name: Schema.String, target: Schema.String })
      ),
    })
  ),
});

const androidSelection: AndroidWorkspaceSelection = corpusAndroidSelection();

const iosSelection: IosWorkspaceSelection = corpusIosSelection();

/** One named node of a snapshot's observation, as an input names it. */
const namedTarget = (
  snapshot: {
    readonly observation: {
      readonly id: string;
      readonly nodes: readonly {
        readonly name: string;
        readonly target: string;
      }[];
    } | null;
  },
  name: string
) => ({
  observationId: snapshot.observation?.id ?? "",
  target:
    snapshot.observation?.nodes.find((node) => node.name === name)?.target ??
    "",
});

/** A counter's count or a histogram's observations, read from a snapshot. */
const metricCount = (
  snapshots: readonly Metric.Metric.Snapshot[],
  id: string,
  attributes: Readonly<Record<string, string>>
) => {
  const found = snapshots.find(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(
        ([key, value]) => snapshot.attributes?.[key] === value
      )
  );
  if (found?.type === "Counter") {
    return Number(found.state.count);
  }
  return found?.type === "Histogram" ? found.state.count : undefined;
};

/** Runs a command whose captures retry on the settle schedule, on TestClock. */
const runSettled = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* advance() {
    const fiber = yield* Effect.forkChild(Effect.result(effect));
    yield* TestClock.adjust("30 seconds");
    return yield* Fiber.join(fiber);
  });

const teachNativeFlow = (input: {
  /** Runs one Workspace command, decoded as the platform's own command. */
  readonly execute: (
    command: Schema.Json,
    source: "agent" | "user"
  ) => Effect.Effect<
    {
      readonly id: AgentSessionId;
      readonly recordingId: TeachingRecordingId | null;
      readonly observation: {
        readonly id: string;
        readonly nodes: readonly {
          readonly name: string;
          readonly target: string;
        }[];
      } | null;
    },
    unknown
  >;
  readonly flowName: FlowName;
  readonly selection: AndroidWorkspaceSelection | IosWorkspaceSelection;
  readonly buttonName: string;
  readonly condition: { readonly name: string; readonly role: string };
  readonly prefix: string;
}) =>
  Effect.gen(function* teach() {
    const started = yield* input.execute(
      {
        _tag: "start",
        flowName: input.flowName,
        kind: "teaching",
        operationId: op(`${input.prefix}-teach-start`),
        recordingId: null,
        selection: input.selection,
      },
      "user"
    );
    yield* input.execute(
      {
        _tag: "prepare",
        operationId: op(`${input.prefix}-teach-prepare`),
        sessionId: started.id,
      },
      "user"
    );
    yield* input.execute(
      {
        _tag: "record",
        operationId: op(`${input.prefix}-teach-record`),
        sessionId: started.id,
        start: true,
      },
      "user"
    );
    const observed = yield* input.execute(
      { _tag: "observe", image: false, sessionId: started.id },
      "agent"
    );
    const buttonTarget = namedTarget(observed, input.buttonName);
    yield* input.execute(
      {
        _tag: "input",
        action: {
          _tag: "activate",
          target: buttonTarget.target,
        },
        observationId: buttonTarget.observationId,
        operationId: op(`${input.prefix}-teach-tap`),
        sessionId: started.id,
      },
      "user"
    );
    const stopped = yield* input.execute(
      {
        _tag: "record",
        operationId: op(`${input.prefix}-teach-stop`),
        sessionId: started.id,
        start: false,
      },
      "user"
    );
    yield* input.execute(
      {
        _tag: "close",
        operationId: op(`${input.prefix}-teach-close`),
        sessionId: started.id,
      },
      "user"
    );
    if (stopped.recordingId === null) {
      return yield* Effect.die("Teaching must own a recording");
    }
    const store = yield* TeachingRecordingStore;
    const learning = yield* TeachingRecordingLearning;
    const claimOp = op(`${input.prefix}-claim`);
    yield* store.startLearning({
      operationId: claimOp,
      recordingId: stopped.recordingId,
    });
    yield* learning.save({
      claimOperationId: claimOp,
      files: [
        {
          content: `---\nname: ${input.flowName}\ndescription: Fixture flow for telemetry.\ninputs:\n---\n\n# Fixture\n\n1. Activate ${input.buttonName}. Done when: done.\n`,
          path: "flow.md",
        },
      ],
      nativeConditions: {
        outcomes: [input.condition],
        starting: [input.condition],
      },
      operationId: op(`${input.prefix}-save`),
      recordingId: stopped.recordingId,
    });
    return stopped.recordingId;
  });

/** The attributes this module sets, which the allowlist must keep. */
const OWN_ATTRIBUTES = new Set([
  "action",
  "operation",
  "outcome",
  "platform",
  "sessionId",
]);

/**
 * Every attribute passed the allowlist: no span holds the secret the agent
 * typed, and the attributes Contingency sets render as themselves. A foreign
 * attribute, such as the tool parameters Effect annotates, renders redacted.
 */
/**
 * The agent's action on `platform` has an `mcp.tool` span naming its
 * session, with `runtime.act` and `runtime.observe` spans inside it.
 */
const expectActionSpans = (
  spans: readonly RecordedSpan[],
  within: (span: RecordedSpan, ancestor: RecordedSpan | undefined) => boolean,
  platform: "android" | "ios",
  sessionId: string
) => {
  const call = spans.find(
    (span) =>
      span.name === "mcp.tool" &&
      span.attributes.get("operation") === "agent_device_workspace" &&
      span.attributes.get("sessionId") === sessionId
  );
  expect(call?.attributes.get("outcome")).toBe("succeeded");
  const inside = (name: string, action?: string) =>
    spans.some(
      (span) =>
        span.name === name &&
        span.attributes.get("platform") === platform &&
        (action === undefined || span.attributes.get("action") === action) &&
        within(span, call)
    );
  expect(inside("runtime.act", "activate")).toBe(true);
  expect(inside("runtime.observe")).toBe(true);
};

const assertShareSafe = (spans: readonly RecordedSpan[]) => {
  for (const span of spans) {
    for (const [key, value] of span.attributes.entries()) {
      expect(String(value), `span ${span.name} attribute ${key}`).not.toContain(
        SECRET
      );
      if (OWN_ATTRIBUTES.has(key)) {
        expect(value, `span ${span.name} attribute ${key}`).not.toBe(REDACTED);
      }
    }
  }
};

it.live(
  "produces mcp.tool with runtime.act and runtime.observe children on Android and iOS, passing the share-safe allowlist",
  () =>
    Effect.gen(function* nativeSpans() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-native-spans-",
      });
      const androidFlow = FlowName.make("android-edit");
      const iosFlow = FlowName.make("ios-login");
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const learningLayer = TeachingRecordingLearningLive.pipe(
        Layer.provideMerge(storeLayer)
      );

      const { layer: tracerLayer, spans, within } = makeRecordingTracer(HOME);
      const androidDevice = makeCorpusNativeBackend({
        device: androidSelection.device,
        platform: "android",
        script: { start: "controls", transitions: [] },
      });
      const androidCtx = yield* Layer.build(
        makeCorpusAndroidWorkspaceLayer({
          device: androidDevice,
          root: () => root,
        }).pipe(
          Layer.provide(Layer.merge(makeFlowCatalogLayer({ root }), storeLayer))
        )
      );
      let hang = false;
      const iosDevice = makeCorpusNativeBackend({
        beforeActivate: () => (hang ? Effect.never : Effect.void),
        device: corpusIosSimulator,
        platform: "ios",
        script: { start: "controls", transitions: [] },
      });
      const iosCtx = yield* Layer.build(
        makeCorpusIosWorkspaceLayer({
          device: iosDevice,
          root: () => root,
        }).pipe(
          Layer.provide(Layer.merge(makeFlowCatalogLayer({ root }), storeLayer))
        )
      );

      const androidWorkspace = Context.get(androidCtx, AndroidWorkspace);
      const iosWorkspace = Context.get(iosCtx, IosWorkspace);

      const androidRecordingId = yield* teachNativeFlow({
        buttonName: "SHOW ALERT",
        condition: { name: "Last action: none", role: "text" },
        execute: (command, source) =>
          androidWorkspace.execute(
            Schema.decodeUnknownSync(AndroidWorkspaceCommand)(command),
            source
          ),
        flowName: androidFlow,
        prefix: "android",
        selection: androidSelection,
      }).pipe(Effect.provide(learningLayer));

      const iosRecordingId = yield* teachNativeFlow({
        buttonName: "Continue",
        condition: { name: "Continue", role: "button" },
        execute: (command, source) =>
          iosWorkspace.execute(
            Schema.decodeUnknownSync(IosWorkspaceCommand)(command),
            source
          ),
        flowName: iosFlow,
        prefix: "ios",
        selection: iosSelection,
      }).pipe(Effect.provide(learningLayer));

      const records: SafeRecord[] = [];
      const origin = yield* servingMcpHttp({
        androidWorkspace: Layer.succeed(AndroidWorkspace, androidWorkspace),
        catalogRoot: root,
        iosWorkspace: Layer.succeed(IosWorkspace, iosWorkspace),
      }).pipe(
        Effect.provide(tracerLayer),
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              records.push(toSafeRecord(options, HOME));
            }),
          ])
        )
      );
      const { request } = yield* connectMcp(origin);

      // Prepare both sessions through their workspace services (user-led setup),
      // then drive agent actions through MCP `agent_code_execute`.
      const androidStarted = yield* androidWorkspace.execute(
        {
          _tag: "start",
          flowName: androidFlow,
          kind: "dry-run",
          operationId: op("android-start"),
          recordingId: androidRecordingId,
          selection: androidSelection,
        },
        "user"
      );
      const androidPrepared = yield* androidWorkspace.execute(
        {
          _tag: "prepare",
          operationId: op("android-prepare"),
          sessionId: androidStarted.id,
        },
        "user"
      );
      const androidTap = namedTarget(androidPrepared, "SHOW ALERT");

      const iosStarted = yield* iosWorkspace.execute(
        {
          _tag: "start",
          flowName: iosFlow,
          kind: "dry-run",
          operationId: op("ios-start"),
          recordingId: iosRecordingId,
          selection: iosSelection,
        },
        "user"
      );
      const iosPrepared = yield* iosWorkspace.execute(
        {
          _tag: "prepare",
          operationId: op("ios-prepare"),
          sessionId: iosStarted.id,
        },
        "user"
      );
      const iosTap = namedTarget(iosPrepared, "Continue");

      const androidActed = Schema.decodeUnknownSync(Answer)(
        yield* request(
          "tools/call",
          operationParams("agent_device_workspace", {
            command: {
              _tag: "input",
              action: { _tag: "activate", target: androidTap.target },
              observationId: androidTap.observationId,
              operationId: "android-act-1",
              sessionId: androidStarted.id,
            },
            platform: "android",
          })
        )
      ).result;
      expect(androidActed.isError).toBe(false);
      expect(androidActed.structuredContent.status).toBe("completed");
      const androidAfter = Schema.decodeUnknownSync(DeviceResult)(
        androidActed.structuredContent.value
      );
      const androidEmailTarget = namedTarget(androidAfter, "Email").target;

      // Also fill a field with a secret to verify it never enters span attributes.
      const androidFilled = Schema.decodeUnknownSync(Answer)(
        yield* request(
          "tools/call",
          operationParams("agent_device_workspace", {
            command: {
              _tag: "input",
              action: {
                _tag: "fill",
                target: androidEmailTarget,
                text: SECRET,
              },
              observationId: androidAfter.observation?.id ?? "",
              operationId: "android-fill-1",
              sessionId: androidStarted.id,
            },
            platform: "android",
          })
        )
      ).result;
      expect(androidFilled.structuredContent.status).toBe("completed");

      const iosActed = Schema.decodeUnknownSync(Answer)(
        yield* request(
          "tools/call",
          operationParams("agent_device_workspace", {
            command: {
              _tag: "input",
              action: { _tag: "activate", target: iosTap.target },
              observationId: iosTap.observationId,
              operationId: "ios-act-1",
              sessionId: iosStarted.id,
            },
            platform: "ios",
          })
        )
      ).result;
      expect(iosActed.isError).toBe(false);
      expect(iosActed.structuredContent.status).toBe("completed");

      // A tap that never answers meets the program's deadline mid-dispatch.
      hang = true;
      const iosAfter = namedTarget(
        Schema.decodeUnknownSync(DeviceResult)(
          iosActed.structuredContent.value
        ),
        "Continue"
      );
      yield* request("tools/call", {
        arguments: {
          code: `return await tools.agent_device_workspace(${JSON.stringify({
            command: {
              _tag: "input",
              action: { _tag: "activate", target: iosAfter.target },
              observationId: iosAfter.observationId,
              operationId: "ios-hung-1",
              sessionId: iosStarted.id,
            },
            platform: "ios",
          })})`,
          timeoutMs: 1000,
        },
        name: "agent_code_execute",
      });

      // An argument the tool refuses never becomes a correlation field.
      yield* request(
        "tools/call",
        operationParams("open_run", { runId: PRIVATE_TOKEN })
      );
      yield* request(
        "tools/call",
        operationParams("agent_device_workspace", {
          command: { _tag: "state", sessionId: PRIVATE_SESSION },
          platform: "ios",
        })
      );
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        expect(JSON.stringify(record)).not.toContain("hunter2-private");
      }

      const mcpSpans = spans.filter((span) => span.name === "mcp.tool");
      const actSpans = spans.filter((span) => span.name === "runtime.act");
      const observeSpans = spans.filter(
        (span) => span.name === "runtime.observe"
      );
      const childSpans = spans.filter((span) => span.name === "child.process");

      expect(childSpans.length).toBeGreaterThan(0);

      expectActionSpans(spans, within, "android", androidStarted.id);
      expectActionSpans(spans, within, "ios", iosStarted.id);

      assertShareSafe([
        ...mcpSpans,
        ...actSpans,
        ...observeSpans,
        ...childSpans,
      ]);

      const snapshots = yield* Metric.snapshot;
      const duration = "contingency.action.duration";
      // Each platform's Teaching tap, then the agent's tap, and on Android
      // the agent's fill. The hung iOS tap still took time, so it counts.
      expect(metricCount(snapshots, duration, { platform: "android" })).toBe(3);
      expect(metricCount(snapshots, duration, { platform: "ios" })).toBe(3);
      expect(
        metricCount(snapshots, "contingency.mcp.calls", {
          operation: "agent_device_workspace",
          outcome: "succeeded",
        })
      ).toBe(3);
      expect(
        metricCount(snapshots, "contingency.mcp.calls", {
          operation: "agent_device_workspace",
          outcome: "interrupted",
        })
      ).toBe(1);
      expect(
        spans.some(
          (span) =>
            span.name === "mcp.tool" &&
            span.attributes.get("outcome") === "interrupted"
        )
      ).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(NodeServices.layer)
    )
);

it.effect(
  "records Capture Gaps (repaired and unrepaired), Pursuit outcomes, Failure References, and sessionId on Diagnostic Log records",
  () =>
    Effect.gen(function* allMetricsAndLogs() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-metrics-gaps-",
      });
      const iosFlow = FlowName.make("ios-gaps");
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const learningLayer = TeachingRecordingLearningLive.pipe(
        Layer.provideMerge(storeLayer)
      );

      const iosDevice = makeCorpusNativeBackend({
        device: corpusIosSimulator,
        platform: "ios",
        script: { start: "controls", transitions: [] },
      });
      const iosLayer = makeCorpusIosWorkspaceLayer({
        device: iosDevice,
        root: () => root,
      }).pipe(
        Layer.provide(Layer.merge(makeFlowCatalogLayer({ root }), storeLayer))
      );
      const records: SafeRecord[] = [];
      const captureLogger = Logger.layer([
        Logger.make((options) => {
          records.push(toSafeRecord(options, HOME));
        }),
      ]);

      const sessionId: AgentSessionId = yield* Effect.gen(function* driveIos() {
        const ios = yield* IosWorkspace;
        const recordingId = yield* teachNativeFlow({
          buttonName: "Continue",
          condition: { name: "Continue", role: "button" },
          execute: (command, source) =>
            ios.execute(
              Schema.decodeUnknownSync(IosWorkspaceCommand)(command),
              source
            ),
          flowName: iosFlow,
          prefix: "gap",
          selection: iosSelection,
        }).pipe(Effect.provide(learningLayer));
        // Clear logs from the Teaching phase so we inspect the Dry Run session.
        records.length = 0;

        const started = yield* ios.execute(
          {
            _tag: "start",
            flowName: iosFlow,
            kind: "dry-run",
            operationId: op("gap-start"),
            recordingId,
            selection: iosSelection,
          },
          "user"
        );
        const prepared = yield* ios.execute(
          {
            _tag: "prepare",
            operationId: op("gap-prepare"),
            sessionId: started.id,
          },
          "user"
        );
        const preparedContinue = namedTarget(prepared, "Continue");
        // 1. Trigger a Capture Gap that automatic recovery repairs.
        iosDevice.failCapturesUntilRecover();
        const repairedFiber = yield* Effect.forkChild(
          ios.execute(
            {
              _tag: "input",
              action: {
                _tag: "activate",
                target: preparedContinue.target,
              },
              observationId: preparedContinue.observationId,
              operationId: op("gap-repaired-act"),
              sessionId: started.id,
            },
            "agent"
          )
        );
        // Let settle retries fail, then automatic recovery clears the failure.
        yield* TestClock.adjust("7 seconds");
        const repairedResult = yield* Fiber.join(repairedFiber);
        expect(repairedResult.captureRepairs?.length ?? 0).toBe(1);

        // 2. An unrepaired Capture Gap: recovery's own capture fails too, so
        // the session pauses with the gap open.
        const repairedContinue = namedTarget(repairedResult, "Continue");
        iosDevice.failNextCaptures(1_000_000);
        const paused = yield* runSettled(
          ios.execute(
            {
              _tag: "input",
              action: {
                _tag: "activate",
                target: repairedContinue.target,
              },
              observationId: repairedContinue.observationId,
              operationId: op("gap-unrepaired-act"),
              sessionId: started.id,
            },
            "agent"
          )
        );
        iosDevice.failNextCaptures(0);
        expect(Result.isFailure(paused)).toBe(true);
        const gaps = "contingency.capture.gaps";
        const beforeRecover = yield* Metric.snapshot;
        expect(metricCount(beforeRecover, gaps, { repaired: "false" })).toBe(1);
        expect(metricCount(beforeRecover, gaps, { repaired: "true" })).toBe(1);

        // The user's Recover repairs the open gap: it moves, never counts twice.
        yield* ios.execute(
          {
            _tag: "recover",
            operationId: op("gap-recover"),
            sessionId: started.id,
          },
          "user"
        );

        // 3. Record a Failure Reference inside the session and a Pursuit outcome.
        yield* Effect.annotateLogs({ sessionId: started.id })(
          recordFailure(
            Cause.fail(new Error("synthetic failure")),
            "runtime_failed"
          )
        );
        yield* recordPursuitOutcome("done");
        return started.id;
      }).pipe(
        Effect.provide(iosLayer),
        Effect.provide(captureLogger),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      );

      const snapshots = yield* Metric.snapshot;
      const gaps = "contingency.capture.gaps";
      expect(metricCount(snapshots, gaps, { repaired: "true" })).toBe(2);
      expect(metricCount(snapshots, gaps, { repaired: "false" })).toBe(0);
      expect(
        metricCount(snapshots, "contingency.pursuit.outcomes", {
          outcome: "done",
        })
      ).toBe(1);
      expect(
        metricCount(snapshots, "contingency.failure.references", {
          code: "runtime_failed",
        })
      ).toBe(1);

      // Every Diagnostic Log record emitted in the session carries sessionId.
      expect(records.length).toBeGreaterThan(0);
      for (const record of records) {
        const fieldMap = new Map(record.fields);
        expect(fieldMap.get("sessionId") ?? fieldMap.get("runId")).toBe(
          sessionId
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provide(NodeServices.layer)
    )
);
