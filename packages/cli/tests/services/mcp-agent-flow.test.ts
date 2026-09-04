import {
  AgentSessionId,
  OperationId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type { AgentFlowDraftProposal } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";

import {
  AgentFlowCatalog,
  makeAgentFlowCatalogLayer,
} from "../../src/services/agent-flow-catalog.ts";
import type { AgentSessionService } from "../../src/services/agent-session.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import {
  AgentFlowToolHandlersLive,
  AgentFlowTools,
} from "../../src/services/mcp-agent-flow.ts";

const at = "2026-09-01T00:00:00.000Z";
const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

const proposal: AgentFlowDraftProposal = {
  description: "A replayable public journey.",
  domainScope: { hosts: ["shop.example.com"] },
  schemaVersion: 1,
  steps: [
    {
      confirmation: false,
      description: "Open the shop.",
      firstActionId: "action-open",
      lastActionId: "action-open",
      name: "Open shop",
    },
  ],
  title: "Replayable shop journey",
};

const slice = {
  actions: [
    {
      action: { type: "navigate" as const, url: "https://shop.example.com/" },
      actor: "agent" as const,
      at,
      description: "Navigate to the shop.",
      id: "action-open",
      outcome: "completed" as const,
      snapshotAfter: null,
      snapshotBefore: null,
      urlAfter: "https://shop.example.com/",
      urlBefore: "about:blank",
    },
  ],
  after: null,
  before: null,
  endedAt: at,
  instructions: [],
  schemaVersion: 1 as const,
  screenshots: [],
  startedAt: at,
  urlTransitions: [],
};

it.effect(
  "replays draft-save through MCP before resolving its old session",
  () =>
    Effect.gen(function* replayBeforeSessionLookup() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-mcp-replay-",
      });
      const missingSession = {
        teachingSource: () =>
          Effect.die("teachingSource should not be called during replay"),
      } as unknown as AgentSessionService;
      const layer = AgentFlowToolHandlersLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            makeAgentFlowCatalogLayer({ now: () => new Date(at), root }),
            Layer.succeed(AgentSession, missingSession)
          ).pipe(Layer.provide(NodeServices.layer))
        )
      );
      yield* Effect.gen(function* exerciseMcpReplay() {
        const catalog = yield* AgentFlowCatalog;
        const sessionId = AgentSessionId.make("agent-missing-after-restart");
        const operationId = OperationId.make("mcp-replay-before-session");
        const saved = yield* catalog.saveDraft({
          basedOnRevisionId: null,
          compiler: { clientName: "compiler", clientVersion: "1" },
          emulation: {
            permissions: [],
            userAgentProfile: UserAgentProfileId.make("default"),
            viewport,
          },
          operationId,
          proposal,
          slices: [slice],
          sourceSessionId: sessionId,
        });
        const handlers = yield* AgentFlowTools;
        const stream = yield* handlers.handle("agent_flow_draft_save", {
          agentFlowId: undefined,
          basedOnRevisionId: null,
          draft: proposal,
          operationId,
          sessionId,
        });
        const results = yield* Stream.runCollect(stream);
        expect(results).toHaveLength(1);
        expect(results[0]?.result).toEqual(saved);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it("exposes no MCP tool that authorizes verification or approves a revision", () => {
  const names = Object.keys(AgentFlowTools.tools);
  expect(names).toContain("agent_flow_archive");
  expect(names).toContain("agent_flow_verification_start");
  expect(names).toContain("agent_flow_verification_complete");
  // Both gestures belong to the user. An agent that could call them would be
  // approving the activity it proposed (ADR 0027).
  expect(
    names.filter(
      (name) => name.includes("approve") || name.includes("authorize")
    )
  ).toEqual([]);
  expect(names.filter((name) => name.includes("delete"))).toEqual([]);
});

it.effect("refuses to start a Verification Run the user never authorized", () =>
  Effect.gen(function* refuseUnauthorizedVerification() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-mcp-verify-",
    });
    const noBrowser = {
      start: () => Effect.die("no Verification Run may start unauthorized"),
    } as unknown as AgentSessionService;
    const layer = AgentFlowToolHandlersLive.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          makeAgentFlowCatalogLayer({ now: () => new Date(at), root }),
          Layer.succeed(AgentSession, noBrowser)
        ).pipe(Layer.provide(NodeServices.layer))
      )
    );
    yield* Effect.gen(function* exerciseUnauthorizedStart() {
      const catalog = yield* AgentFlowCatalog;
      const saved = yield* catalog.saveDraft({
        basedOnRevisionId: null,
        compiler: { clientName: "compiler", clientVersion: "1" },
        emulation: {
          permissions: [],
          userAgentProfile: UserAgentProfileId.make("default"),
          viewport,
        },
        operationId: OperationId.make("verify-unauthorized-save"),
        proposal,
        slices: [slice],
        sourceSessionId: AgentSessionId.make("agent-teaching"),
      });
      const handlers = yield* AgentFlowTools;
      const stream = yield* handlers.handle("agent_flow_verification_start", {
        agentFlowId: saved.manifest.agentFlowId,
        clientName: undefined,
        clientVersion: undefined,
        operationId: OperationId.make("verify-unauthorized-start"),
        revisionId: saved.manifest.revisionId,
      });
      const refused = yield* Effect.flip(Stream.runCollect(stream));
      expect("code" in refused ? refused.code : refused._tag).toBe(
        "agent_flow_conflict"
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
