import path from "node:path";

import { ContingencyRpcs, OperationId } from "@contingency/protocol";
import type { AgentRunId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { RpcHandlersLive } from "../../src/routes/rpc.ts";
import {
  AgentFlowCatalog,
  makeAgentFlowCatalogLayer,
} from "../../src/services/agent-flow-catalog.ts";
import {
  AGENT_RUNS_DIRECTORY,
  makeAgentRunStoreLayer,
} from "../../src/services/agent-run-store.ts";
import {
  AgentSession,
  makeAgentSessionLayer,
} from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  AgentFlowToolHandlersLive,
  AgentFlowTools,
} from "../../src/services/mcp-agent-flow.ts";
import {
  AgentRunToolHandlersLive,
  AgentRunTools,
} from "../../src/services/mcp-agent-run.ts";
import {
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { RunSession } from "../../src/services/run-session.ts";
import {
  findNode,
  makeCall,
  requireBoundary,
  requireRun,
} from "./agent-harness.ts";
import { fixtureServer, NEVER_ANSWERED } from "./harness.ts";

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 } as const;

const session = makeCall(AgentSessionTools);
const flow = makeCall(AgentFlowTools);
const run = makeCall(AgentRunTools);

/**
 * One MCP process's whole surface over one Catalog Root. Each call builds a
 * fresh registry, which is how this test spends more than one process
 * lifetime: nothing but the persisted catalog and Run packages crosses
 * between them.
 */
const processLayer = (catalogRoot: string) =>
  Layer.mergeAll(
    RpcHandlersLive,
    AgentSessionToolHandlersLive,
    AgentFlowToolHandlersLive,
    AgentRunToolHandlersLive
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        RecordingLive,
        makeAgentSessionLayer({
          baseUrl: "http://127.0.0.1:7777",
          traceDirectory: () => path.join(catalogRoot, "teaching"),
        }),
        makeAgentFlowCatalogLayer({ root: catalogRoot }),
        makeAgentRunStoreLayer({ root: () => catalogRoot })
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    ),
    Layer.provide(
      Layer.succeed(RunSession, {
        answerVariable: () => Effect.die("Not under test"),
        artifactPath: () => Effect.die("Not under test"),
        changes: () => Stream.never,
        get: () => Effect.succeed(null),
        loadFlow: () => Effect.die("Not under test"),
        start: () => Effect.die("Not under test"),
      })
    )
  );

/**
 * Teach, verify, and approve one three-Step journey, then end the whole MCP
 * process. What survives is the catalog on disk and nothing else.
 */
const approveJourney = (
  loginUrl: string,
  fixtureHost: string,
  confirmation = false
) =>
  Effect.gen(function* teachAndApprove() {
    const catalog = yield* AgentFlowCatalog;
    const taught = yield* session("agent_session_start", {
      activity: "teaching",
      clientName: "teaching-agent",
      clientVersion: "1.0.0",
      operationId: OperationId.make("start-teaching"),
      url: loginUrl,
      viewport,
    });
    const observed = yield* session("agent_browser_snapshot", {
      sessionId: taught.id,
    });
    const display = findNode(observed.nodes, "textbox", "Display name");
    const mobile = findNode(observed.nodes, "textbox", "Mobile number");
    const signIn = findNode(observed.nodes, "button", "Sign in");
    yield* session("agent_browser_act", {
      action: { ref: display.ref, text: "Ada", type: "fill" },
      operationId: OperationId.make("teach-display"),
      sessionId: taught.id,
    });
    yield* session("agent_browser_act", {
      action: { ref: mobile.ref, text: "555", type: "fill" },
      operationId: OperationId.make("teach-mobile"),
      sessionId: taught.id,
    });
    yield* session("agent_browser_act", {
      action: { ref: signIn.ref, type: "click" },
      operationId: OperationId.make("teach-sign-in"),
      sessionId: taught.id,
    });
    const feed = yield* flow("agent_teaching_feed_get", {
      includeSnapshots: false,
      sessionId: taught.id,
    });
    const [first, second, third] = feed.actions;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Teaching lost the demonstrated actions.");
    }
    const proposal = {
      description: "Sign in with a display name and a mobile number.",
      domainScope: { hosts: [fixtureHost] },
      schemaVersion: 1 as const,
      steps: [
        {
          confirmation,
          description: "Enter the display name.",
          firstActionId: first.id,
          lastActionId: first.id,
          name: "Enter the display name",
        },
        {
          confirmation: false,
          description: "Enter the mobile number.",
          firstActionId: second.id,
          lastActionId: second.id,
          name: "Enter the mobile number",
        },
        {
          confirmation: false,
          description: "Sign in.",
          firstActionId: third.id,
          lastActionId: third.id,
          name: "Sign in",
        },
      ],
      title: "Sign in to the account",
    };
    const saved = yield* flow("agent_flow_draft_save", {
      basedOnRevisionId: null,
      draft: proposal,
      operationId: OperationId.make("save-draft"),
      sessionId: taught.id,
    });
    const { agentFlowId, revisionId } = saved.manifest;
    yield* catalog.authorizeVerification({
      agentFlowId,
      operationId: OperationId.make("authorize"),
      revisionId,
    });
    const verifying = yield* flow("agent_flow_verification_start", {
      agentFlowId,
      clientName: "teaching-agent",
      clientVersion: "1.0.0",
      operationId: OperationId.make("verify"),
      revisionId,
    });
    if (confirmation) {
      const user = yield* RpcTest.makeClient(ContingencyRpcs, {
        flatten: true,
      });
      const verificationPage = yield* session("agent_browser_act", {
        action: { type: "navigate", url: loginUrl },
        operationId: OperationId.make("verify-navigation"),
        sessionId: verifying.id,
      });
      const { ref } = findNode(
        verificationPage.snapshot.nodes,
        "textbox",
        "Display name"
      );
      const unmarked = yield* session("agent_browser_act", {
        action: {
          ref: findNode(
            verificationPage.snapshot.nodes,
            "textbox",
            "Mobile number"
          ).ref,
          text: "555",
          type: "fill",
        },
        intent: { objective: "Enter the mobile number" },
        operationId: OperationId.make("verify-unmarked-objective"),
        sessionId: verifying.id,
      });
      expect(unmarked.entry.outcome).toBe("completed");
      expect(unmarked.intervention).toBeUndefined();
      const request = {
        action: { ref, text: "Ada", type: "fill" as const },
        intent: { objective: "Enter the display name" },
        operationId: OperationId.make("verify-confirmation"),
        sessionId: verifying.id,
      };
      const refused = yield* session("agent_browser_act", request);
      expect(requireBoundary(refused).reason).toBe("confirmation");
      yield* user("agent.boundary.resolve", {
        data: {
          boundaryId: requireBoundary(refused).id,
          decision: "allow",
          operationId: OperationId.make("verify-user-confirm"),
          sessionId: verifying.id,
        },
        type: "agent.boundary.resolve",
      });
      expect((yield* session("agent_browser_act", request)).entry.outcome).toBe(
        "completed"
      );
    }
    // A Verification Run is not an Interactive Run of an Approved Agent Flow.
    expect(verifying.run).toBeNull();
    yield* flow("agent_flow_verification_complete", {
      operationId: OperationId.make("verified"),
      outcome: "passed",
      sessionId: verifying.id,
      summary: "The journey worked in a fresh context.",
    });
    yield* session("agent_session_close", {
      operationId: OperationId.make("close-verification"),
      sessionId: verifying.id,
    });
    yield* catalog.approve({
      agentFlowId,
      operationId: OperationId.make("approve"),
      revisionId,
    });
    // An agent may not run a draft revision, only an Approved Agent Flow.
    const draftRun = yield* flow("agent_flow_draft_save", {
      agentFlowId,
      basedOnRevisionId: revisionId,
      draft: { ...proposal, title: "A later proposal" },
      operationId: OperationId.make("save-later-draft"),
      sessionId: taught.id,
    });
    const refusedDraft = yield* Effect.flip(
      run("agent_flow_run_start", {
        agentFlowId,
        clientName: "run-agent",
        clientVersion: "2.0.0",
        operationId: OperationId.make("run-a-draft"),
        revisionId: draftRun.manifest.revisionId,
      })
    );
    expect(refusedDraft.code).toBe("agent_flow_conflict");
    yield* session("agent_session_close", {
      operationId: OperationId.make("close-teaching"),
      sessionId: taught.id,
    });
    return { agentFlowId, revisionId };
  });

/**
 * The whole later-conversation half of the milestone over one real Chromium: a
 * new MCP process finds the Approved Agent Flow by search, runs its ordered
 * Agent Steps, retries inside a Step, submits evidence-backed assessments,
 * loses a Run to a ceiling, and leaves persistent Run Summaries a third
 * process can open read-only
 * ([ADR 0029](../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
it.live(
  "finds an Approved Agent Flow in a later process and runs it to a Run Summary",
  () =>
    Effect.gen(function* runAnApprovedJourney() {
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-agent-run-",
      });
      const fixtures = yield* fixtureServer;
      const loginUrl = fixtures.url("agent-login.html");
      const fixtureHost = new URL(loginUrl).hostname;

      // ---- First process lifetime: teach and approve. --------------------
      const approved = yield* approveJourney(loginUrl, fixtureHost).pipe(
        Effect.scoped,
        Effect.provide(processLayer(catalogRoot))
      );

      // ---- Second process lifetime: find it and run it. ------------------
      const runIds = yield* Effect.gen(function* laterConversation() {
        const found = yield* flow("agent_catalog_search", {
          query: "sign in account",
          status: "approved",
        });
        expect(found.hits).toMatchObject([
          {
            agentFlowId: approved.agentFlowId,
            revisionId: approved.revisionId,
            status: "approved",
            stepCount: 3,
          },
        ]);

        // -- A Run that stops on a terminal Agent Assessment. --------------
        const started = yield* run("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          clientName: "run-agent",
          clientVersion: "2.0.0",
          operationId: OperationId.make("start-run-a"),
          reportedModel: "a-model-the-client-named",
          reportedProvider: "a-provider-the-client-named",
          runCeilingMs: 120_000,
          stepCeilingMs: 60_000,
        });
        expect(started.activity).toBe("run");
        expect(started.teaching).toBeNull();
        expect(started.verification).toBeNull();
        expect(started.viewUrl).toContain(`session=${started.id}`);
        const initial = requireRun(started);
        expect(initial.activeStepIndex).toBe(0);
        expect(initial.steps.map((step) => step.execution)).toEqual([
          "active",
          "pending",
          "pending",
        ]);
        expect(initial.coverage).toEqual({
          complete: false,
          executed: 0,
          total: 3,
          unexecuted: 3,
        });
        // Attribution is observed for the client and unverified for its claim.
        expect(initial.attribution).toEqual({
          clientName: "run-agent",
          clientVersion: "2.0.0",
          reportedMetadataVerified: false,
          reportedModel: "a-model-the-client-named",
          reportedProvider: "a-provider-the-client-named",
        });

        // The agent chooses its own reversible path inside the Agent Step,
        // and every attempt joins the timeline.
        const navigated = yield* session("agent_browser_act", {
          action: { type: "navigate", url: loginUrl },
          operationId: OperationId.make("run-a-navigate"),
          sessionId: started.id,
        });
        const display = findNode(
          navigated.snapshot.nodes,
          "textbox",
          "Display name"
        );
        yield* session("agent_browser_act", {
          action: { ref: display.ref, text: "Ad", type: "fill" },
          operationId: OperationId.make("run-a-fill-first-try"),
          sessionId: started.id,
        });
        const retried = yield* session("agent_browser_act", {
          action: { ref: display.ref, text: "Ada", type: "fill" },
          operationId: OperationId.make("run-a-fill-retry"),
          sessionId: started.id,
        });
        const afterAttempts = yield* session("agent_session_get", {
          sessionId: started.id,
        });
        expect(requireRun(afterAttempts).steps[0]?.attempts).toBe(3);
        expect(afterAttempts.timeline).toHaveLength(3);

        // An assessment may only cite evidence this Agent Step produced.
        const fabricated = yield* Effect.flip(
          run("agent_run_step_assess", {
            evidence: [{ id: "snapshot-that-never-existed", kind: "snapshot" }],
            explanation: "The field accepted the name.",
            operationId: OperationId.make("run-a-fabricated"),
            outcome: "working",
            sessionId: started.id,
          })
        );
        expect(fabricated.code).toBe("agent_session_invalid");

        const advanced = yield* run("agent_run_step_assess", {
          evidence: [
            { id: retried.snapshot.snapshotId, kind: "snapshot" },
            { id: retried.entry.id, kind: "attempt" },
          ],
          explanation: "The display name field shows Ada.",
          operationId: OperationId.make("run-a-assess-one"),
          outcome: "working",
          sessionId: started.id,
        });
        const afterFirst = requireRun(advanced);
        expect(afterFirst.activeStepIndex).toBe(1);
        expect(afterFirst.steps.map((step) => step.execution)).toEqual([
          "assessed",
          "active",
          "pending",
        ]);
        expect(afterFirst.assessmentCounts.working).toBe(1);
        expect(afterFirst.outcome).toBeNull();
        // The next Agent Step starts with its own evidence, so the previous
        // Step's observations cannot justify it.
        const staleEvidence = yield* Effect.flip(
          run("agent_run_step_assess", {
            evidence: [{ id: retried.snapshot.snapshotId, kind: "snapshot" }],
            explanation: "Reusing what the previous Step observed.",
            operationId: OperationId.make("run-a-stale-evidence"),
            outcome: "working",
            sessionId: started.id,
          })
        );
        expect(staleEvidence.code).toBe("agent_session_invalid");

        // A repeated operation id answers with the original result.
        const replayed = yield* run("agent_run_step_assess", {
          evidence: [
            { id: retried.snapshot.snapshotId, kind: "snapshot" },
            { id: retried.entry.id, kind: "attempt" },
          ],
          explanation: "The display name field shows Ada.",
          operationId: OperationId.make("run-a-assess-one"),
          outcome: "working",
          sessionId: started.id,
        });
        expect(requireRun(replayed).activeStepIndex).toBe(1);
        expect(requireRun(replayed).assessmentCounts.working).toBe(1);

        const observedAgain = yield* session("agent_browser_snapshot", {
          sessionId: started.id,
        });
        const ended = yield* run("agent_run_step_assess", {
          evidence: [{ id: observedAgain.snapshotId, kind: "snapshot" }],
          explanation: "The mobile number field never accepted the number.",
          operationId: OperationId.make("run-a-assess-two"),
          outcome: "not-working",
          sessionId: started.id,
        });
        const terminal = requireRun(ended);
        expect(terminal.outcome).toBe("ended-early");
        expect(terminal.activeStepIndex).toBeNull();
        expect(terminal.steps.map((step) => step.execution)).toEqual([
          "assessed",
          "assessed",
          "unexecuted",
        ]);
        // Assessment counts and coverage are two different facts.
        expect(terminal.assessmentCounts).toEqual({
          blocked: 0,
          inconclusive: 0,
          notWorking: 1,
          working: 1,
        });
        expect(terminal.coverage).toEqual({
          complete: false,
          executed: 2,
          total: 3,
          unexecuted: 1,
        });

        // The Run is over, so the browser accepts nothing further from the
        // agent even though it has not been finalized yet.
        const afterEnd = yield* Effect.flip(
          session("agent_browser_act", {
            action: { action: "reload", type: "history" },
            operationId: OperationId.make("run-a-after-end"),
            sessionId: started.id,
          })
        );
        expect(afterEnd.code).toBe("agent_session_conflict");

        const summaryA = yield* run("agent_run_complete", {
          operationId: OperationId.make("complete-run-a"),
          sessionId: started.id,
          summary: "The mobile number step did not work.",
        });
        expect(summaryA.outcome).toBe("ended-early");
        expect(summaryA.coverage.complete).toBe(false);
        expect(summaryA.assessmentCounts.notWorking).toBe(1);
        expect(summaryA.videoPath).not.toBeNull();
        expect(summaryA.tracePath).not.toBeNull();
        expect(summaryA.attribution.reportedMetadataVerified).toBe(false);
        // Finalizing is idempotent: a transport retry does not run again.
        expect(
          yield* run("agent_run_complete", {
            operationId: OperationId.make("complete-run-a"),
            sessionId: started.id,
            summary: "The mobile number step did not work.",
          })
        ).toEqual(summaryA);
        // The live browser is closed and Agent View is in summary mode.
        const closed = yield* session("agent_session_get", {
          sessionId: started.id,
        });
        expect(closed.phase).toBe("closed");
        expect(requireRun(closed).outcome).toBe("ended-early");

        // -- A Run a hard ceiling ends. -----------------------------------
        const bounded = yield* run("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          clientName: "run-agent",
          clientVersion: "2.0.0",
          operationId: OperationId.make("start-run-b"),
          runCeilingMs: 120_000,
          stepCeilingMs: 1000,
        });
        // The ceiling lands while an action is in flight — a navigation the
        // fixture server deliberately never answers — so the breach must
        // interrupt the active action rather than wait it out.
        yield* Effect.forkChild(
          session("agent_browser_act", {
            action: {
              type: "navigate",
              url: `${fixtures.origin}${NEVER_ANSWERED}`,
            },
            operationId: OperationId.make("run-b-hanging-navigate"),
            sessionId: bounded.id,
          }).pipe(Effect.ignore)
        );
        yield* Effect.sleep("4 seconds");
        const timedOut = yield* session("agent_session_get", {
          sessionId: bounded.id,
        });
        const breached = requireRun(timedOut);
        expect(breached.outcome).toBe("timed-out");
        expect(timedOut.interruptedAction?.detail).toContain(
          "interrupted this action"
        );
        // A ceiling is a system fact, not a judgment the Runner made up.
        expect(breached.steps[0]?.execution).toBe("timed-out");
        expect(breached.steps[0]?.assessment).toBeNull();
        expect(breached.steps.map((step) => step.execution)).toEqual([
          "timed-out",
          "unexecuted",
          "unexecuted",
        ]);
        expect(breached.coverage).toEqual({
          complete: false,
          executed: 1,
          total: 3,
          unexecuted: 2,
        });
        expect(breached.assessmentCounts).toEqual({
          blocked: 0,
          inconclusive: 0,
          notWorking: 0,
          working: 0,
        });
        const afterCeiling = yield* Effect.flip(
          run("agent_run_step_assess", {
            evidence: [{ id: "anything", kind: "snapshot" }],
            explanation: "Too late.",
            operationId: OperationId.make("run-b-assess"),
            outcome: "working",
            sessionId: bounded.id,
          })
        );
        expect(afterCeiling.code).toBe("agent_session_conflict");
        const summaryB = yield* run("agent_run_complete", {
          operationId: OperationId.make("complete-run-b"),
          sessionId: bounded.id,
        });
        expect(summaryB.outcome).toBe("timed-out");
        expect(summaryB.summary).toBeNull();

        // Extending a ceiling is a direct user action with no MCP tool.
        expect(
          [
            ...Object.keys(AgentRunTools.tools),
            ...Object.keys(AgentFlowTools.tools),
            ...Object.keys(AgentSessionTools.tools),
          ].filter((name) => /ceiling|extend/u.test(name))
        ).toEqual([]);

        // -- A Run that reaches every Agent Step. -------------------------
        const complete = yield* run("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          clientName: "run-agent",
          clientVersion: "2.0.0",
          operationId: OperationId.make("start-run-c"),
          runCeilingMs: 120_000,
          stepCeilingMs: 2000,
        });
        const local = yield* AgentSession;
        // The user raises both ceilings from Agent View, and only the user can.
        const extended = yield* local.extendCeiling(
          complete.id,
          "step",
          60_000,
          OperationId.make("extend-step")
        );
        expect(requireRun(extended).ceilings.stepMs).toBe(62_000);
        expect(requireRun(extended).ceilings.extensions).toBe(1);
        yield* local.extendCeiling(
          complete.id,
          "run",
          60_000,
          OperationId.make("extend-run")
        );

        let current = complete;
        for (const [index, label] of [
          "Display name",
          "Mobile number",
          "Sign in",
        ].entries()) {
          const page = yield* session("agent_browser_act", {
            action: { type: "navigate", url: loginUrl },
            operationId: OperationId.make(`run-c-observe-${index}`),
            sessionId: complete.id,
          });
          expect(
            page.snapshot.nodes.some((node) => node.name.includes(label))
          ).toBe(true);
          current = yield* run("agent_run_step_assess", {
            evidence: [{ id: page.snapshot.snapshotId, kind: "snapshot" }],
            explanation: `${label} behaved as the Agent Flow describes.`,
            operationId: OperationId.make(`run-c-assess-${index}`),
            outcome: "working",
            sessionId: complete.id,
          });
        }
        const finished = requireRun(current);
        expect(finished.outcome).toBe("completed");
        expect(finished.coverage).toEqual({
          complete: true,
          executed: 3,
          total: 3,
          unexecuted: 0,
        });
        expect(finished.assessmentCounts.working).toBe(3);
        const summaryC = yield* run("agent_run_complete", {
          operationId: OperationId.make("complete-run-c"),
          sessionId: complete.id,
          summary: "Every Agent Step worked.",
        });
        expect(summaryC.outcome).toBe("completed");
        expect(summaryC.coverage.complete).toBe(true);
        return {
          completed: summaryC.runId,
          endedEarly: summaryA.runId,
          timedOut: summaryB.runId,
        };
      }).pipe(Effect.scoped, Effect.provide(processLayer(catalogRoot)));

      // ---- Third process lifetime: open the persisted Runs read-only. ----
      yield* Effect.gen(function* readOnlyViewer() {
        for (const runId of Object.values(runIds)) {
          const viewer = yield* run("open_run", { runId });
          expect(viewer.summary.runId).toBe(runId);
          expect(viewer.viewUrl).toContain(`run=${runId}`);
          // The viewer is a link to persisted evidence, not a live session.
          expect(viewer.viewUrl).not.toContain("session=");
        }
        const absent = yield* Effect.flip(
          run("open_run", { runId: "agentrun-never" as AgentRunId })
        );
        expect(absent.code).toBe("agent_run_not_found");
        // No browser was reopened to read them.
        expect(yield* (yield* AgentSession).list()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(processLayer(catalogRoot)));

      // The Run's evidence is one self-contained local package.
      const videoFile = path.join(
        catalogRoot,
        AGENT_RUNS_DIRECTORY,
        runIds.endedEarly,
        (yield* fileSystem.readDirectory(
          path.join(catalogRoot, AGENT_RUNS_DIRECTORY, runIds.endedEarly)
        )).find((file) => file.endsWith(".webm")) ?? "missing.webm"
      );
      expect(yield* fileSystem.exists(videoFile)).toBe(true);
      expect(Number((yield* fileSystem.stat(videoFile)).size)).toBeGreaterThan(
        0
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "enforces domain, objective, and one-attempt confirmation through MCP and user RPC",
  () =>
    Effect.gen(function* exerciseBoundary() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "boundary-",
      });
      const fixtures = yield* fixtureServer;
      const approved = yield* approveJourney(
        fixtures.url("agent-login.html"),
        "127.0.0.1",
        true
      ).pipe(Effect.scoped, Effect.provide(processLayer(root)));
      yield* Effect.gen(function* runBoundary() {
        const user = yield* RpcTest.makeClient(ContingencyRpcs, {
          flatten: true,
        });
        const local = yield* AgentSession;
        const started = yield* run("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          operationId: OperationId.make("boundary-start"),
        });
        const sessionId = started.id;
        let sequence = 0;
        const decide = (boundaryId: string, decision: "allow" | "refuse") =>
          user("agent.boundary.resolve", {
            data: {
              boundaryId,
              decision,
              operationId: OperationId.make(`decision-${(sequence += 1)}`),
              sessionId,
            },
            type: "agent.boundary.resolve",
          });
        const act = (
          operation: string,
          action: Parameters<typeof local.act>[1],
          intent?: Parameters<typeof local.act>[3]
        ) =>
          session("agent_browser_act", {
            action,
            ...(intent === undefined ? {} : { intent }),
            operationId: OperationId.make(operation),
            sessionId,
          });
        const opened = yield* act("open-boundary", {
          type: "navigate",
          url: fixtures.url("boundary-approved-redirect"),
        });
        expect(opened.url).toBe(fixtures.url("agent-boundary.html"));
        const external = fixtures
          .url("outside-boundary")
          .replace("127.0.0.1", "localhost");
        const domain = yield* act("outside", {
          type: "navigate",
          url: external,
        });
        expect(requireBoundary(domain).reason).toBe("domain");
        expect(domain.entry.dispatched).toBe(false);
        expect(fixtures.requests).not.toContain("/outside-boundary");
        yield* decide(requireBoundary(domain).id, "refuse");
        const target = findNode(
          opened.snapshot.nodes,
          "button",
          "Submit purchase"
        );
        const objective = yield* act(
          "new-objective",
          { ref: target.ref, type: "hover" },
          { objective: "Delete the account" }
        );
        expect(requireBoundary(objective).reason).toBe("objective");
        yield* user("agent.session.takeover", {
          data: {
            operationId: OperationId.make("boundary-takeover"),
            reason: "Inspect the paused request",
            sessionId,
          },
          type: "agent.session.takeover",
        });
        yield* Effect.flip(decide(requireBoundary(objective).id, "allow"));
        const paused = yield* local.get(sessionId);
        expect(paused.controller).toBe("user");
        expect(paused.boundary?.id).toBe(requireBoundary(objective).id);
        yield* user("agent.session.control.return", {
          data: { operationId: OperationId.make("boundary-return"), sessionId },
          type: "agent.session.control.return",
        });
        yield* decide(requireBoundary(objective).id, "allow");
        const resumed = yield* act(
          "new-objective",
          { ref: target.ref, type: "hover" },
          { objective: "Delete the account" }
        );
        expect(resumed.entry.outcome).toBe("completed");
        const purchase = { ref: target.ref, type: "click" as const };
        const optedOut = yield* act("cannot-opt-out", purchase, {
          irreversible: false,
        });
        expect(requireBoundary(optedOut).reason).toBe("confirmation");
        yield* decide(requireBoundary(optedOut).id, "refuse");
        expect(Object.keys(AgentSessionTools.tools)).not.toContain(
          "agent_boundary_resolve"
        );
        const confirmation = yield* act("purchase", purchase);
        expect(requireBoundary(confirmation).reason).toBe("confirmation");
        expect(fixtures.requests).not.toContain("/boundary-submit");
        yield* decide(requireBoundary(confirmation).id, "allow");
        const [result, duplicate] = yield* Effect.all(
          [act("purchase", purchase), act("purchase", purchase)],
          { concurrency: "unbounded" }
        );
        expect(result).toEqual(duplicate);
        expect(
          fixtures.requests.filter((url) => url === "/boundary-submit")
        ).toHaveLength(1);
        const retry = yield* act("purchase-again", purchase);
        expect(requireBoundary(retry).reason).toBe("confirmation");
        yield* decide(requireBoundary(retry).id, "refuse");
        const uncertain = findNode(
          result.snapshot.nodes,
          "button",
          "Uncertain submission"
        );
        const submit = { ref: uncertain.ref, type: "click" as const };
        const submitBoundary = yield* act("uncertain", submit);
        yield* decide(requireBoundary(submitBoundary).id, "allow");
        const timeout = yield* Effect.flip(act("uncertain", submit));
        expect(
          fixtures.requests.filter((url) => url === NEVER_ANSWERED)
        ).toHaveLength(1);
        expect(yield* Effect.flip(act("uncertain", submit))).toEqual(timeout);
        const restored = yield* act("restore-after-uncertain", {
          type: "navigate",
          url: fixtures.url("agent-boundary.html"),
        });
        const retryRef = findNode(
          restored.snapshot.nodes,
          "button",
          "Uncertain submission"
        ).ref;
        const uncertainRetry = yield* act("uncertain-retry", {
          ref: retryRef,
          type: "click",
        });
        expect(requireBoundary(uncertainRetry).reason).toBe("confirmation");
        expect(
          fixtures.requests.filter((url) => url === NEVER_ANSWERED)
        ).toHaveLength(1);
        yield* decide(requireBoundary(uncertainRetry).id, "refuse");
        const redirect = yield* act("redirect", {
          type: "navigate",
          url: fixtures.url("boundary-redirect-chain"),
        });
        expect(requireBoundary(redirect).reason).toBe("domain");
        expect(fixtures.requests).not.toContain("/outside-boundary");
        yield* decide(requireBoundary(redirect).id, "refuse");
        for (const [index, label] of [
          "Outside link",
          "Outside popup",
        ].entries()) {
          const fresh = yield* act(`link-page-${index}`, {
            type: "navigate",
            url: fixtures.url("agent-boundary.html"),
          });
          const link = findNode(fresh.snapshot.nodes, "link", label);
          const click = { ref: link.ref, type: "click" as const };
          const confirmedLink = yield* act(`link-${index}`, click);
          yield* decide(requireBoundary(confirmedLink).id, "allow");
          const refusedLink = yield* act(`link-${index}`, click);
          const [navigationPaused] = yield* local.changes(sessionId).pipe(
            Stream.filter(
              (snapshot) =>
                snapshot.boundary !== undefined && snapshot.boundary !== null
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("2 seconds")
          );
          expect(navigationPaused?.boundary?.reason).toBe("domain");
          expect(fixtures.requests).not.toContain("/outside-boundary");
          if (
            navigationPaused?.boundary === undefined ||
            navigationPaused.boundary === null
          ) {
            throw new Error("Missing navigation boundary");
          }
          expect(refusedLink.entry.dispatched).toBe(true);
          yield* decide(navigationPaused.boundary.id, "refuse");
        }
        const second = yield* run("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          operationId: OperationId.make("second-boundary-run"),
        });
        const secondRequest = {
          action: {
            type: "navigate" as const,
            url: fixtures
              .url("agent-boundary.html")
              .replace("127.0.0.1", "localhost"),
          },
          operationId: OperationId.make("second-domain"),
          sessionId: second.id,
        };
        const secondBoundary = yield* session(
          "agent_browser_act",
          secondRequest
        );
        yield* user("agent.boundary.resolve", {
          data: {
            boundaryId: requireBoundary(secondBoundary).id,
            decision: "allow",
            operationId: OperationId.make("allow-second-domain"),
            sessionId: second.id,
          },
          type: "agent.boundary.resolve",
        });
        expect((yield* session("agent_browser_act", secondRequest)).url).toBe(
          secondRequest.action.url
        );
        const stillScoped = yield* act("outside", {
          type: "navigate",
          url: external,
        });
        expect(requireBoundary(stillScoped).reason).toBe("domain");
        yield* run("agent_run_complete", {
          operationId: OperationId.make("complete-second-boundary-run"),
          sessionId: second.id,
        });
        const summary = yield* run("agent_run_complete", {
          operationId: OperationId.make("boundary-complete"),
          sessionId,
          summary: "Boundary refusals retained",
        });
        expect((yield* local.get(sessionId)).boundary).toBeNull();
        expect(
          summary.timeline.filter((entry) => entry.outcome === "refused").length
        ).toBeGreaterThanOrEqual(8);
      }).pipe(Effect.scoped, Effect.provide(processLayer(root)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
