import path from "node:path";

import type { AgentSessionId } from "@contingency/protocol";
import {
  TaskAgentRunSummary,
  AgentSessionSnapshot,
  FlowName,
  OperationId,
  RecordingView,
  TeachingRecordingId,
  UserAgentProfileId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import {
  makeTeachingRecordingStoreLayer,
  TeachingRecordingStore,
} from "../../src/services/teaching-recording-store.ts";
import {
  connectMcp,
  operationParams,
  servingMcpHttp,
} from "../helpers/mcp-http.ts";
import type { JsonValue } from "../helpers/mcp-http.ts";
import { fixtureServer } from "../integration/harness.ts";

const recordingId = TeachingRecordingId.make("recording-review");
const operation = OperationId.make;
const emulation = {
  permissions: [],
  userAgentProfile: UserAgentProfileId.make("default"),
  viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
};
const Response = Schema.Struct({
  result: Schema.Struct({
    structuredContent: Schema.Struct({
      status: Schema.String,
      diagnostic: Schema.optional(Schema.Unknown),
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});

const client = (origin: string) =>
  Effect.gen(function* codeClient() {
    const { request } = yield* connectMcp(origin);
    return (name: string, args: Record<string, JsonValue>) =>
      Effect.gen(function* execute() {
        const answer = Schema.decodeUnknownSync(Response)(
          yield* request("tools/call", operationParams(name, args))
        ).result.structuredContent;
        expect(answer.diagnostic).toBeUndefined();
        expect(answer.status).toBe("completed");
        return answer.value;
      });
  });

// Capture is seeded through its owning store; session closure, Dry Run startup,
// completion, and reopening use production services through the sole code tool.
const draft = (root: string, teachingId: AgentSessionId) =>
  Effect.gen(function* draftRecording() {
    const files = yield* FileSystem.FileSystem;
    const store = yield* TeachingRecordingStore;
    yield* store.begin({
      emulation,
      flowName: FlowName.make("review"),
      operationId: operation("begin"),
      recordingId,
      sessionId: teachingId,
    });
    yield* store.start({
      emulation,
      operationId: operation("start"),
      recordingId,
    });
    yield* store.stop({
      artifacts: [],
      operationId: operation("stop"),
      recordingId,
    });
    yield* store.startLearning({
      operationId: operation("learn"),
      recordingId,
    });
    yield* files.writeFileString(
      path.join(root, "review", "flow.md"),
      `---\nname: review\ndescription: Review the local page.\ninputs: []\nhosts:\n  - 127.0.0.1\n---\n\n1. Read the page.\n   Done when: The page is visible.\n`
    );
    yield* store.saveFlow({
      claimOperationId: operation("learn"),
      files: ["flow.md"],
      operationId: operation("save"),
      recordingId,
    });
  }).pipe(
    Effect.provide(makeTeachingRecordingStoreLayer({ root: () => root }))
  );

const completeAfterTeachingCloses = (root: string) =>
  Effect.gen(function* closedTeaching() {
    const fixture = yield* fixtureServer;
    const url = fixture.url("cart.html");
    const origin = yield* servingMcpHttp({
      catalogRoot: root,
      workspaceUrl: "http://127.0.0.1:8123/",
    });
    const call = yield* client(origin);
    const started = Schema.decodeUnknownSync(AgentSessionSnapshot)(
      yield* call("agent_session_start", {
        activity: "teaching",
        name: "review",
        group: "",
        clientName: "review-test",
        clientVersion: "1",
        operationId: "teaching",
        url,
        viewport: emulation.viewport,
        view: "full",
      })
    );
    yield* call("agent_session_close", {
      sessionId: started.id,
      operationId: "close-teaching",
    });
    yield* draft(root, started.id);
    const dry = Schema.decodeUnknownSync(
      Schema.Struct({ session: AgentSessionSnapshot })
    )(
      yield* call("agent_flow_dry_run_start", {
        inputs: [],
        operationId: "dry",
        recordingId,
        url,
        view: "full",
      })
    );
    const completed = Schema.decodeUnknownSync(
      Schema.Struct({
        ...TaskAgentRunSummary.fields,
        viewUrl: Schema.optional(Schema.String),
      })
    )(
      yield* call("agent_run_complete", {
        sessionId: dry.session.id,
        operationId: "complete",
      })
    );
    const { viewUrl, ...summary } = completed;
    const files = yield* FileSystem.FileSystem;
    expect(
      yield* files.readFileString(
        path.join(root, "review", "runs", summary.runId, "summary.json")
      )
    ).not.toContain('"viewUrl"');
    return { call, summary, viewUrl };
  });

// One hang guard covers browser startup and interpreter dispatch, never readiness.
const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.timeout("60 seconds"),
    Effect.provide(NodeServices.layer)
  );

it.live(
  "returns a pending Summary and recording URL when Teaching closes before the Dry Run starts",
  () =>
    live(
      Effect.gen(function* closedTeachingReview() {
        const files = yield* FileSystem.FileSystem;
        const root = yield* files.makeTempDirectoryScoped();
        const { call, summary, viewUrl } =
          yield* completeAfterTeachingCloses(root);
        expect(viewUrl).toBe(
          "http://127.0.0.1:8123/?recording=recording-review"
        );
        const opened = Schema.decodeUnknownSync(
          Schema.Struct({ ...RecordingView.fields, viewUrl: Schema.String })
        )(yield* call("open_recording", { recordingId }));
        expect(opened).toMatchObject({ decision: "pending", summary, viewUrl });
      })
    ),
  60_000
);

it.live(
  "opens the same persisted Summary on a fresh MCP layer's Workspace URL without original sessions",
  () =>
    live(
      Effect.gen(function* freshProcessReview() {
        const files = yield* FileSystem.FileSystem;
        const root = yield* files.makeTempDirectoryScoped();
        // End the entire first server and its services before building fresh ones.
        const { summary } = yield* completeAfterTeachingCloses(root).pipe(
          Effect.scoped
        );
        const origin = yield* servingMcpHttp({
          catalogRoot: root,
          workspaceUrl: "http://127.0.0.1:9234/",
        });
        const call = yield* client(origin);
        expect(yield* call("agent_sessions_get", {})).toMatchObject({
          sessions: [],
        });
        const opened = Schema.decodeUnknownSync(
          Schema.Struct({ ...RecordingView.fields, viewUrl: Schema.String })
        )(yield* call("open_recording", { recordingId }));
        expect(opened).toEqual({
          decision: "pending",
          result: expect.anything(),
          summary,
          viewUrl: "http://127.0.0.1:9234/?recording=recording-review",
        });
      })
    ),
  60_000
);
