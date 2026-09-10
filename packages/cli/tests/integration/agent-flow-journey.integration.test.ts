import path from "node:path";

import { ContingencyRpcs, OperationId } from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentFlowDraftProposal,
  AgentSessionId,
  TeachingFeed,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Stream } from "effect";
import { RpcTest } from "effect/unstable/rpc";

import { AGENT_RUNS_DIRECTORY } from "../../src/services/agent-run-store.ts";
import {
  agentOwnerMarker,
  prepareAgentResourceDirectory,
} from "../../src/services/agent-session-resources.ts";
import { AgentSession } from "../../src/services/agent-session.ts";
import {
  agentProcessLayer,
  agentViewport,
  findNode,
  flowTool,
  requireBoundary,
  resolveBoundary,
  resolveVariable,
  requireRun,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { fixtureServer, NEVER_ANSWERED } from "./harness.ts";

/** What the user knows and Contingency must never write down. */
const MOBILE_LITERAL = "5550137";
const PASSWORD_LITERAL = "correct-horse-battery";
const TEACHING_OTP = "246801";
const RUN_OTP = "135790";

const literals = [
  MOBILE_LITERAL,
  PASSWORD_LITERAL,
  TEACHING_OTP,
  RUN_OTP,
] as const;

/** Agent View's loopback RPC: every gesture below is a direct user action. */
const agentView = RpcTest.makeClient(ContingencyRpcs, { flatten: true });

const fillTextOf = (
  feed: TeachingFeed,
  text: string
): TeachingFeed["actions"][number] => {
  const found = feed.actions.find(
    ({ action }) => action.type === "fill" && action.text === text
  );
  if (found === undefined) {
    throw new Error(
      `The Teaching Feed recorded no fill of ${text}: ${feed.actions
        .map(
          ({ action }) =>
            `${action.type}/${"text" in action ? action.text : ""}`
        )
        .join(", ")}`
    );
  }
  return found;
};

/**
 * The whole Milestone 1 journey, end to end, over one real Chromium and one
 * Catalog Root: a catalog miss, mixed-control Teaching with private Variables,
 * a user correction, one authorized Verification Run, approval, the end of the
 * first Agent Session — and then a second MCP process that finds the Approved
 * Agent Flow by search and performs it with a mid-Run Takeover, an OTP, an
 * Execution Boundary, and a video-backed Run Summary a third process reads.
 *
 * Nothing is faked at the acceptance seam: real HTTP fixtures, real Chromium,
 * the public MCP toolkits, and Agent View's loopback RPC
 * ([ADR 0029](../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
it.live(
  "teaches, verifies, approves, finds, and reruns one login Agent Flow",
  () =>
    Effect.gen(function* proveTheLoginJourney() {
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-agent-journey-",
      });
      const fixtures = yield* fixtureServer;
      const loginUrl = fixtures.url("agent-login.html");
      const fixtureHost = new URL(loginUrl).hostname;

      // ---- First process lifetime: teach, verify, approve. ---------------
      const taughtArtifacts = yield* Effect.gen(function* teachAndApprove() {
        const user = yield* agentView;

        // The journey begins with a catalog miss: there is nothing to run, so
        // the agent has to ask the user to teach the journey.
        const missed = yield* flowTool("agent_catalog_search", {
          query: "sign in with a one-time code",
          status: "approved",
        });
        expect(missed.hits).toEqual([]);

        const teaching = yield* sessionTool("agent_session_start", {
          activity: "teaching",
          clientName: "journey-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("journey-start-teaching"),
          url: loginUrl,
          viewport: agentViewport,
        });
        expect(teaching.viewUrl).toContain(`session=${teaching.id}`);

        // What the user told the agent to do, as the agent relayed it.
        yield* flowTool("agent_teaching_instruction_record", {
          operationId: OperationId.make("journey-instruction"),
          sessionId: teaching.id,
          text: "Sign in with my mobile number, my password, and the code my phone shows.",
        });

        const observed = yield* sessionTool("agent_browser_snapshot", {
          sessionId: teaching.id,
        });
        const display = findNode(observed.nodes, "textbox", "Display name");
        const mobile = findNode(observed.nodes, "textbox", "Mobile number");
        const password = findNode(observed.nodes, "textbox", "Password");
        const otp = findNode(observed.nodes, "textbox", "digit 1 of 6");
        const signIn = findNode(observed.nodes, "button", "Sign in");

        // The agent focuses the field, and the user types the public name
        // itself: mixed control, not a transcript of agent clicks.
        yield* sessionTool("agent_browser_act", {
          action: { ref: display.ref, type: "click" },
          operationId: OperationId.make("journey-focus-display"),
          sessionId: teaching.id,
        });
        yield* user("agent.session.takeover", {
          data: {
            operationId: OperationId.make("journey-takeover-display"),
            reason: "Type the display name yourself.",
            sessionId: teaching.id,
          },
          type: "agent.session.takeover",
        });
        for (const key of ["A", "d", "a"]) {
          for (const eventType of ["keyDown", "keyUp"] as const) {
            const input = {
              eventType,
              key,
              type: "input_keyboard" as const,
            };
            yield* user("agent.browser.input.send", {
              data: {
                input:
                  eventType === "keyDown" ? { ...input, text: key } : input,
                sessionId: teaching.id,
              },
              type: "agent.browser.input.send",
            });
          }
        }

        // A reusable private identifier: the user enters it while holding the
        // browser, and only the declaration is captured.
        yield* user("agent.session.control.return", {
          data: {
            operationId: OperationId.make("journey-return-display"),
            sessionId: teaching.id,
          },
          type: "agent.session.control.return",
        });
        yield* sessionTool("agent_browser_act", {
          action: { ref: mobile.ref, type: "click" },
          operationId: OperationId.make("journey-focus-mobile"),
          sessionId: teaching.id,
        });
        yield* user("agent.session.takeover", {
          data: {
            operationId: OperationId.make("journey-takeover-mobile"),
            reason: "Enter your mobile number privately.",
            sessionId: teaching.id,
          },
          type: "agent.session.takeover",
        });
        yield* user("agent.teaching.variable.input", {
          data: {
            operationId: OperationId.make("journey-enter-mobile"),
            sessionId: teaching.id,
            value: MOBILE_LITERAL,
            variable: { name: "MOBILE", runtime: true, secret: true },
          },
          type: "agent.teaching.variable.input",
        });
        yield* user("agent.session.control.return", {
          data: {
            operationId: OperationId.make("journey-return-mobile"),
            sessionId: teaching.id,
          },
          type: "agent.session.control.return",
        });

        // The agent enters the remaining private values on the user's behalf,
        // naming the Variable rather than holding the literal.
        yield* sessionTool("agent_teaching_variable_input", {
          operationId: OperationId.make("journey-enter-password"),
          ref: password.ref,
          sessionId: teaching.id,
          value: PASSWORD_LITERAL,
          variable: { name: "PASSWORD", runtime: true, secret: true },
        });
        const enteredOtp = yield* sessionTool("agent_teaching_variable_input", {
          operationId: OperationId.make("journey-enter-otp"),
          ref: otp.ref,
          sessionId: teaching.id,
          value: TEACHING_OTP,
          variable: { name: "OTP", runtime: true, secret: true },
        });
        expect(
          findNode(enteredOtp.snapshot.nodes, "output", "Verification ready")
            .name
        ).toBe("Verification ready");
        yield* sessionTool("agent_browser_screenshot", {
          sessionId: teaching.id,
        });
        yield* sessionTool("agent_browser_act", {
          action: { ref: signIn.ref, type: "click" },
          operationId: OperationId.make("journey-click-sign-in"),
          sessionId: teaching.id,
        });

        // The Teaching Feed is bounded evidence: enough to compile, and none
        // of the literals or raw Trace data
        // (ADR 0032).
        const feed = yield* flowTool("agent_teaching_feed_get", {
          includeSnapshots: true,
          sessionId: teaching.id,
        });
        const exported = JSON.stringify(feed);
        for (const literal of literals) {
          expect(exported).not.toContain(literal);
        }
        expect(Object.keys(feed)).not.toContain("trace");
        expect(exported).not.toContain(".trace.zip");
        expect(exported).not.toContain(".webm");
        expect(feed.variables).toEqual([
          { name: "MOBILE", runtime: true, secret: true },
          { name: "PASSWORD", runtime: true, secret: true },
          { name: "OTP", runtime: true, secret: true },
        ]);
        expect(feed.instructions.map(({ text }) => text)).toContain(
          "Sign in with my mobile number, my password, and the code my phone shows."
        );
        expect(feed.snapshots.length).toBeGreaterThan(0);
        expect(feed.screenshots.length).toBeGreaterThan(0);

        const userTyped = fillTextOf(feed, "Ada");
        expect(userTyped.actor).toBe("user");
        const mobileFill = fillTextOf(feed, "{{MOBILE}}");
        expect(mobileFill.actor).toBe("user");
        const passwordFill = fillTextOf(feed, "{{PASSWORD}}");
        const otpFill = fillTextOf(feed, "{{OTP}}");
        const clicked = feed.actions.at(-1);
        const [opening] = feed.actions;
        if (clicked === undefined || opening === undefined) {
          throw new Error("Teaching lost the demonstrated actions.");
        }

        // Objective-level Agent Steps over Contingency-derived spans.
        const proposal: AgentFlowDraftProposal = {
          description:
            "Sign in with a reusable mobile identifier, a password, and a one-time code.",
          domainScope: { hosts: [fixtureHost] },
          schemaVersion: 1,
          steps: [
            {
              confirmation: false,
              description: "Identify the account by name and mobile number.",
              firstActionId: opening.id,
              lastActionId: mobileFill.id,
              name: "Identify the account",
            },
            {
              confirmation: false,
              description: "Authenticate with the password and one-time code.",
              firstActionId: passwordFill.id,
              lastActionId: otpFill.id,
              name: "Authenticate",
            },
            {
              confirmation: false,
              description: "Submit the sign-in.",
              firstActionId: clicked.id,
              lastActionId: clicked.id,
              name: "Sign in",
            },
          ],
          title: "Sign in with a one-time code",
          variables: feed.variables,
        };
        const saved = yield* flowTool("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: proposal,
          operationId: OperationId.make("journey-save-draft"),
          sessionId: teaching.id,
        });
        const { agentFlowId } = saved.manifest;
        // Every Agent Step carries an Evidence Slice Contingency derived, not
        // one the compiling agent wrote.
        expect(saved.manifest.steps).toHaveLength(3);
        for (const step of saved.manifest.steps) {
          expect(step.evidence.hash).toMatch(/^sha256-[\da-f]+$/u);
        }

        const refusedCorrection = yield* Effect.flip(
          flowTool("agent_flow_draft_update", {
            agentFlowId,
            basedOnRevisionId: saved.manifest.revisionId,
            draft: {
              ...proposal,
              domainScope: { hosts: ["outside.example.com"] },
            },
            operationId: OperationId.make("journey-refuse-correction"),
            sessionId: teaching.id,
          })
        );
        expect(refusedCorrection.code).toBe("agent_flow_invalid");
        expect(
          (refusedCorrection.diagnostics ?? []).map(({ code }) => code)
        ).toEqual(
          expect.arrayContaining(["unobserved_domain", "uncovered_host"])
        );
        expect(
          (yield* flowTool("agent_flow_get", { agentFlowId })).manifest
            .revisionId
        ).toBe(saved.manifest.revisionId);

        // The user reviews Variables and Domain Scope, then confirms an agent
        // correction in the MCP conversation. The last Step becomes a
        // Confirmation Step.
        const review = yield* user("agent.flow.revision.get", {
          data: { agentFlowId, revisionId: saved.manifest.revisionId },
          type: "agent.flow.revision.get",
        });
        expect(review.data.revision.manifest.variables).toEqual(feed.variables);
        expect(review.data.revision.manifest.domainScope.hosts).toEqual([
          fixtureHost,
        ]);
        expect(review.data.evidence).toHaveLength(3);

        const correctedProposal: AgentFlowDraftProposal = {
          ...proposal,
          steps: [
            ...proposal.steps.slice(0, 2),
            {
              confirmation: true,
              description: "Submit the sign-in and confirm it with me.",
              firstActionId: clicked.id,
              lastActionId: clicked.id,
              name: "Submit the sign-in",
            },
          ],
        };
        const corrected = yield* flowTool("agent_flow_draft_update", {
          agentFlowId,
          basedOnRevisionId: saved.manifest.revisionId,
          draft: correctedProposal,
          operationId: OperationId.make("journey-correct-draft"),
          sessionId: teaching.id,
        });
        const { revisionId } = corrected.manifest;
        expect(revisionId).not.toBe(saved.manifest.revisionId);

        // Verification is unfunded until the user says so, and the correction
        // is a different draft: neither revision may be verified yet.
        for (const unfunded of [saved.manifest.revisionId, revisionId]) {
          const refusedStart = yield* Effect.flip(
            flowTool("agent_flow_verification_start", {
              agentFlowId,
              clientName: "journey-agent",
              clientVersion: "1.0.0",
              operationId: OperationId.make(`journey-unfunded-${unfunded}`),
              revisionId: unfunded,
            })
          );
          expect(refusedStart.code).toBe("agent_flow_conflict");
        }

        // A direct user action funds exactly one Verification Run of exactly
        // this revision (ADR 0027).
        yield* user("agent.flow.verification.authorize", {
          data: {
            agentFlowId,
            operationId: OperationId.make("journey-authorize"),
            revisionId,
            sessionId: teaching.id,
          },
          type: "agent.flow.verification.authorize",
        });
        const verifying = yield* flowTool("agent_flow_verification_start", {
          agentFlowId,
          clientName: "journey-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("journey-verify"),
          revisionId,
        });
        expect(verifying.id).not.toBe(teaching.id);
        // Authorizing from a navigated page opens verification there rather
        // than on a blank page the agent would have to leave first.
        expect(verifying.currentUrl).toBe(loginUrl);
        // Verification is a fresh browser context that asks for the Variables
        // again rather than inheriting what Teaching prepared.
        expect(verifying.verification?.variables).toEqual([
          { name: "MOBILE", runtime: true, secret: true, supplied: false },
          { name: "PASSWORD", runtime: true, secret: true, supplied: false },
          { name: "OTP", runtime: true, secret: true, supplied: false },
        ]);
        // An in-scope navigate remains allowed before the active Step's work.
        const verificationPage = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: loginUrl },
          intent: { objective: "Open the login page to begin verification" },
          operationId: OperationId.make("journey-verify-navigate"),
          sessionId: verifying.id,
        });
        expect(verificationPage.intervention).toBeUndefined();
        // A lookalike host no Domain Scope entry covers is still refused.
        const lookalike = yield* sessionTool("agent_browser_act", {
          action: {
            type: "navigate",
            url: loginUrl.replace("127.0.0.1", "localhost"),
          },
          intent: { objective: "Open the login page to begin verification" },
          operationId: OperationId.make("journey-verify-lookalike"),
          sessionId: verifying.id,
        });
        expect(requireBoundary(lookalike).reason).toBe("domain");
        yield* resolveBoundary({
          boundaryId: requireBoundary(lookalike).id,
          decision: "refuse",
          operationId: "journey-verify-lookalike-refuse",
          sessionId: verifying.id,
        });
        // Nothing Teaching prepared survived into the fresh context.
        expect(
          findNode(verificationPage.snapshot.nodes, "textbox", "Password")
            .value ?? ""
        ).toBe("");
        expect(JSON.stringify(verificationPage)).not.toContain(MOBILE_LITERAL);

        // A non-navigate action with an unrecognised objective still pauses.
        const unnamed = yield* sessionTool("agent_browser_act", {
          action: {
            ref: findNode(verificationPage.snapshot.nodes, "button", "Sign in")
              .ref,
            type: "hover",
          },
          intent: { objective: "Delete the account", objectiveKind: "new" },
          operationId: OperationId.make("journey-verify-unknown-objective"),
          sessionId: verifying.id,
        });
        expect(requireBoundary(unnamed).reason).toBe("objective");
        yield* resolveBoundary({
          boundaryId: requireBoundary(unnamed).id,
          decision: "refuse",
          operationId: "journey-verify-unknown-refuse",
          sessionId: verifying.id,
        });

        for (const [name, value] of [
          ["MOBILE", MOBILE_LITERAL],
          ["PASSWORD", PASSWORD_LITERAL],
          ["OTP", TEACHING_OTP],
        ] as const) {
          const supplied = yield* resolveVariable({
            decision: "supply",
            name,
            operationId: `journey-verify-supply-${name}`,
            sessionId: verifying.id,
            value,
          });
          expect(JSON.stringify(supplied)).not.toContain(value);
        }

        /** A Confirmation Step guards only the Step currently being verified. */
        const withUserConfirmation = <E, R>(
          attempt: Effect.Effect<AgentActionResult, E, R>,
          confirmationId: string,
          requested: string
        ) =>
          Effect.gen(function* confirmOnce() {
            const first = yield* attempt;
            if (first.intervention === undefined) {
              throw new Error("Expected an Execution Boundary");
            }
            expect(first.intervention.reason).toBe("confirmation");
            // What the user is asked to confirm describes this action, not
            // whichever Step happens to carry the Confirmation marker.
            expect(first.intervention.requested).toBe(requested);
            yield* resolveBoundary({
              boundaryId: first.intervention.id,
              decision: "allow",
              operationId: confirmationId,
              sessionId: verifying.id,
            });
            return yield* attempt;
          });

        const enterVariable = (
          name: "MOBILE" | "PASSWORD" | "OTP",
          label: string
        ) =>
          sessionTool("agent_variable_enter", {
            name,
            operationId: OperationId.make(`journey-verify-enter-${name}`),
            ref: findNode(verificationPage.snapshot.nodes, "textbox", label)
              .ref,
            sessionId: verifying.id,
          });
        const mobileEntered = yield* enterVariable("MOBILE", "Mobile number");
        yield* runTool("agent_run_step_assess", {
          evidence: [
            {
              id: mobileEntered.snapshot.snapshotId,
              kind: "snapshot" as const,
            },
          ],
          explanation:
            "The account identity fields accepted the supplied value.",
          operationId: OperationId.make("journey-verify-assess-identity"),
          outcome: "working",
          sessionId: verifying.id,
        });
        const passwordEntered = yield* enterVariable("PASSWORD", "Password");
        const otpEntered = yield* enterVariable("OTP", "digit 1 of 6");
        for (const entered of [mobileEntered, passwordEntered, otpEntered]) {
          expect(entered.entry.outcome).toBe("completed");
          for (const literal of literals) {
            expect(JSON.stringify(entered)).not.toContain(literal);
          }
        }
        yield* runTool("agent_run_step_assess", {
          evidence: [
            { id: otpEntered.snapshot.snapshotId, kind: "snapshot" as const },
          ],
          explanation:
            "The authentication fields accepted both supplied values.",
          operationId: OperationId.make("journey-verify-assess-authentication"),
          outcome: "working",
          sessionId: verifying.id,
        });

        // The Confirmation Step the user added is enforced by name.
        const submitted = yield* withUserConfirmation(
          sessionTool("agent_browser_act", {
            action: {
              ref: findNode(
                verificationPage.snapshot.nodes,
                "button",
                "Sign in"
              ).ref,
              type: "click",
            },
            intent: { objective: "Submit the sign-in" },
            operationId: OperationId.make("journey-verify-submit"),
            sessionId: verifying.id,
          }),
          "journey-verify-confirm-submit",
          "Submit the sign-in"
        );
        expect(submitted.entry.outcome).toBe("completed");
        yield* runTool("agent_run_step_assess", {
          evidence: [
            { id: submitted.snapshot.snapshotId, kind: "snapshot" as const },
          ],
          explanation: "Submitting the sign-in reached the expected state.",
          operationId: OperationId.make("journey-verify-assess-submit"),
          outcome: "working",
          sessionId: verifying.id,
        });

        yield* flowTool("agent_flow_verification_complete", {
          operationId: OperationId.make("journey-verified"),
          outcome: "passed",
          sessionId: verifying.id,
          summary: "The fresh context signed in with the supplied Variables.",
        });
        yield* sessionTool("agent_session_close", {
          operationId: OperationId.make("journey-close-verification"),
          sessionId: verifying.id,
        });

        // What the Teaching session holds locally, before approval retires it.
        const artifacts = yield* (yield* AgentSession).teachingSource(
          teaching.id
        );
        expect(artifacts.artifactRetention).toEqual({
          location: "local",
          sensitive: true,
        });
        const { retentionFile, traceFile, videoFile } = artifacts;
        if (
          retentionFile === undefined ||
          traceFile === undefined ||
          videoFile === undefined
        ) {
          throw new Error("Teaching allocated no local sensitive artifacts.");
        }
        // Both are on disk while Teaching is still live — the browser only
        // flushes the recording on context close, so their size proves nothing
        // yet, but their later absence is a deletion rather than a capture
        // that never happened.
        expect(yield* fileSystem.exists(videoFile)).toBe(true);
        expect(yield* fileSystem.exists(retentionFile)).toBe(true);

        // The second direct user action: approval of the exact verified
        // immutable revision.
        const approved = yield* user("agent.flow.approve", {
          data: {
            agentFlowId,
            operationId: OperationId.make("journey-approve"),
            revisionId,
          },
          type: "agent.flow.approve",
        });
        expect(approved.data.revision.manifest.status).toBe("approved");
        expect(approved.data.revision.heads.approvedRevisionId).toBe(
          revisionId
        );

        // The first Agent Session ends and releases everything it owned.
        const closed = yield* sessionTool("agent_session_close", {
          operationId: OperationId.make("journey-close-teaching"),
          sessionId: teaching.id,
        });
        expect(closed.phase).toBe("closed");
        expect((yield* sessionTool("agent_sessions_get", {})).sessions).toEqual(
          []
        );

        return { agentFlowId, retentionFile, revisionId, traceFile, videoFile };
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(catalogRoot)));

      const { agentFlowId, revisionId } = taughtArtifacts;

      // Default retention removed the full Demonstration Trace and its video
      // once the revision was approved, and said so in the record it keeps.
      // The catalog package did not move.
      for (const file of [
        taughtArtifacts.traceFile,
        taughtArtifacts.videoFile,
      ]) {
        expect(yield* fileSystem.exists(file)).toBe(false);
      }
      expect(
        JSON.parse(
          yield* fileSystem.readFileString(taughtArtifacts.retentionFile)
        )
      ).toMatchObject({ retention: "delete-on-approval" });
      const revisionDirectory = path.join(
        catalogRoot,
        "agent-flows",
        agentFlowId,
        "revisions",
        revisionId
      );
      expect(yield* fileSystem.exists(revisionDirectory)).toBe(true);

      // ---- Second process lifetime: find it and run it. ------------------
      const runId = yield* Effect.gen(function* laterConversation() {
        const user = yield* agentView;

        // A later MCP process searches the same Catalog Root and finds it.
        const found = yield* flowTool("agent_catalog_search", {
          query: "sign in one-time code",
          status: "approved",
        });
        expect(found.hits).toMatchObject([
          { agentFlowId, revisionId, status: "approved", stepCount: 3 },
        ]);

        const started = yield* runTool("agent_flow_run_start", {
          agentFlowId,
          clientName: "later-agent",
          clientVersion: "3.1.0",
          operationId: OperationId.make("journey-run-start"),
          reportedModel: "a-model-the-client-named",
          reportedProvider: "a-provider-the-client-named",
          runCeilingMs: 150_000,
          stepCeilingMs: 90_000,
        });
        const sessionId: AgentSessionId = started.id;
        // MCP client attribution is observed; the model claim is not.
        expect(requireRun(started).attribution).toEqual({
          clientName: "later-agent",
          clientVersion: "3.1.0",
          reportedMetadataVerified: false,
          reportedModel: "a-model-the-client-named",
          reportedProvider: "a-provider-the-client-named",
        });
        expect(requireRun(started).steps.map(({ name }) => name)).toEqual([
          "Identify the account",
          "Authenticate",
          "Submit the sign-in",
        ]);
        expect(
          started.pendingDecisions
            .filter((decision) => decision.kind === "supply_variable")
            .map((decision) => decision.variable)
        ).toEqual([
          { name: "MOBILE", secret: true },
          { name: "PASSWORD", secret: true },
          { name: "OTP", secret: true },
        ]);

        // Agent View shows the live browser while the Run executes.
        const frame = yield* user("agent.browser.stream.subscribe", {
          data: { sessionId },
          type: "agent.browser.stream.subscribe",
        }).pipe(
          Stream.filter((event) => event.type === "frame"),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? Effect.succeed(head.value)
              : Effect.die("Agent View never received a browser frame.")
          ),
          Effect.timeout("20 seconds")
        );
        expect(frame.data.length).toBeGreaterThan(0);

        // -- Agent Step one: the agent chooses its own reversible path. ----
        const page = yield* sessionTool("agent_browser_act", {
          action: { type: "navigate", url: loginUrl },
          operationId: OperationId.make("journey-run-navigate"),
          sessionId,
        });
        const display = findNode(
          page.snapshot.nodes,
          "textbox",
          "Display name"
        );
        yield* sessionTool("agent_browser_act", {
          action: { ref: display.ref, text: "Ada", type: "fill" },
          operationId: OperationId.make("journey-run-fill-display"),
          sessionId,
        });
        yield* resolveVariable({
          decision: "supply",
          name: "MOBILE",
          operationId: "journey-run-supply-mobile",
          sessionId,
          value: MOBILE_LITERAL,
        });
        const mobileEntered = yield* sessionTool("agent_variable_enter", {
          name: "MOBILE",
          operationId: OperationId.make("journey-run-enter-mobile"),
          ref: findNode(page.snapshot.nodes, "textbox", "Mobile number").ref,
          sessionId,
        });
        const stepOne = yield* runTool("agent_run_step_assess", {
          evidence: [
            { id: mobileEntered.snapshot.snapshotId, kind: "snapshot" },
            { id: mobileEntered.entry.id, kind: "attempt" },
          ],
          explanation: "The account fields accepted the name and the number.",
          operationId: OperationId.make("journey-run-assess-one"),
          outcome: "working",
          sessionId,
        });
        expect(requireRun(stepOne).activeStepIndex).toBe(1);

        // -- Agent Step two: the agent asks for the user, who enters the OTP.
        yield* resolveVariable({
          decision: "supply",
          name: "PASSWORD",
          operationId: "journey-run-supply-password",
          sessionId,
          value: PASSWORD_LITERAL,
        });
        const passwordEntered = yield* sessionTool("agent_variable_enter", {
          name: "PASSWORD",
          operationId: OperationId.make("journey-run-enter-password"),
          ref: findNode(page.snapshot.nodes, "textbox", "Password").ref,
          sessionId,
        });
        const requested = yield* sessionTool("agent_session_takeover_request", {
          operationId: OperationId.make("journey-run-request-takeover"),
          reason: "I need the one-time code from your phone.",
          sessionId,
        });
        expect(requested.takeover?.requestedBy).toBe("agent");
        yield* user("agent.session.takeover", {
          data: {
            operationId: OperationId.make("journey-run-takeover"),
            reason: "Entering the one-time code.",
            sessionId,
          },
          type: "agent.session.takeover",
        });

        // The user closes Agent View and opens it again. Each half is its own
        // loopback client lifetime, so the session has to outlive a view that
        // disconnected entirely rather than a second call on a live one: the
        // view is a window onto a process-owned session, not the session.
        yield* Effect.scoped(
          Effect.gen(function* watchThenClose() {
            const firstView = yield* agentView;
            yield* firstView("agent.session.stream.subscribe", {
              data: { sessionId },
              type: "agent.session.stream.subscribe",
            }).pipe(Stream.runHead, Effect.timeout("20 seconds"));
          })
        );
        const reopened = yield* Effect.scoped(
          Effect.gen(function* openAgain() {
            const secondView = yield* agentView;
            return yield* secondView("agent.session.get", {
              data: { sessionId },
              type: "agent.session.get",
            });
          })
        );
        expect(reopened.data.session.controller).toBe("user");
        expect(requireRun(reopened.data.session).outcome).toBeNull();
        expect(requireRun(reopened.data.session).activeStepIndex).toBe(1);

        yield* resolveVariable({
          decision: "supply",
          name: "OTP",
          operationId: "journey-run-supply-otp",
          sessionId,
          value: RUN_OTP,
        });
        const returned = yield* user("agent.session.control.return", {
          data: {
            operationId: OperationId.make("journey-run-return"),
            sessionId,
          },
          type: "agent.session.control.return",
        });
        expect(returned.data.session.controller).toBe("agent");

        const otpEntered = yield* sessionTool("agent_variable_enter", {
          name: "OTP",
          operationId: OperationId.make("journey-run-enter-otp"),
          ref: findNode(page.snapshot.nodes, "textbox", "digit 1 of 6").ref,
          sessionId,
        });
        expect(
          findNode(otpEntered.snapshot.nodes, "output", "Verification ready")
            .name
        ).toBe("Verification ready");
        for (const literal of literals) {
          expect(JSON.stringify(otpEntered)).not.toContain(literal);
          expect(JSON.stringify(passwordEntered)).not.toContain(literal);
        }
        const stepTwo = yield* runTool("agent_run_step_assess", {
          evidence: [{ id: otpEntered.snapshot.snapshotId, kind: "snapshot" }],
          explanation: "The page reported the one-time code as complete.",
          operationId: OperationId.make("journey-run-assess-two"),
          outcome: "working",
          sessionId,
        });
        expect(requireRun(stepTwo).activeStepIndex).toBe(2);

        // -- Agent Step three: the Confirmation Step the user added. -------
        const submit = {
          action: {
            ref: findNode(page.snapshot.nodes, "button", "Sign in").ref,
            type: "click" as const,
          },
          intent: { objective: "Submit the sign-in" },
          operationId: OperationId.make("journey-run-submit"),
          sessionId,
        };
        const bounded = yield* sessionTool("agent_browser_act", submit);
        expect(requireBoundary(bounded).reason).toBe("confirmation");
        yield* resolveBoundary({
          boundaryId: requireBoundary(bounded).id,
          decision: "allow",
          operationId: "journey-run-confirm",
          sessionId,
        });
        const submitted = yield* sessionTool("agent_browser_act", submit);
        expect(submitted.entry.outcome).toBe("completed");
        // A replayed operation id answers with the original result rather than
        // clicking the page a second time.
        const timelineLength = (yield* sessionTool("agent_session_get", {
          sessionId,
        })).timeline.length;
        expect(yield* sessionTool("agent_browser_act", submit)).toEqual(
          submitted
        );
        expect(
          (yield* sessionTool("agent_session_get", { sessionId })).timeline
            .length
        ).toBe(timelineLength);

        const finished = yield* runTool("agent_run_step_assess", {
          evidence: [
            { id: submitted.snapshot.snapshotId, kind: "snapshot" },
            { id: submitted.entry.id, kind: "attempt" },
          ],
          explanation: "The sign-in was submitted and the page confirmed it.",
          operationId: OperationId.make("journey-run-assess-three"),
          outcome: "working",
          sessionId,
        });
        const finalState = requireRun(finished);
        expect(finalState.outcome).toBe("completed");
        // Assessment counts and coverage are reported as two different facts.
        expect(finalState.assessmentCounts).toEqual({
          blocked: 0,
          inconclusive: 0,
          notWorking: 0,
          working: 3,
        });
        expect(finalState.coverage).toEqual({
          complete: true,
          executed: 3,
          total: 3,
          unexecuted: 0,
        });
        // Replaying the terminal assessment mutates nothing.
        expect(
          yield* runTool("agent_run_step_assess", {
            evidence: [
              { id: submitted.snapshot.snapshotId, kind: "snapshot" },
              { id: submitted.entry.id, kind: "attempt" },
            ],
            explanation: "The sign-in was submitted and the page confirmed it.",
            operationId: OperationId.make("journey-run-assess-three"),
            outcome: "working",
            sessionId,
          })
        ).toEqual(finished);

        const summary = yield* runTool("agent_run_complete", {
          operationId: OperationId.make("journey-run-complete"),
          sessionId,
          summary: "Every Agent Step of the login journey worked.",
        });
        expect(summary.outcome).toBe("completed");
        expect(summary.attribution.reportedMetadataVerified).toBe(false);
        expect(summary.videoPath).not.toBeNull();
        // Replaying the finalization does not run anything a second time.
        expect(
          yield* runTool("agent_run_complete", {
            operationId: OperationId.make("journey-run-complete"),
            sessionId,
            summary: "Every Agent Step of the login journey worked.",
          })
        ).toEqual(summary);

        // Agent View is in summary mode over a local, video-backed Run.
        const closed = yield* user("agent.session.get", {
          data: { sessionId },
          type: "agent.session.get",
        });
        expect(closed.data.session.phase).toBe("closed");
        const viewed = yield* user("agent.run.summary.get", {
          data: { runId: summary.runId },
          type: "agent.run.summary.get",
        });
        expect(viewed.data.summary.runId).toBe(summary.runId);
        expect(viewed.data.viewUrl).toContain(`run=${summary.runId}`);
        expect((yield* sessionTool("agent_sessions_get", {})).sessions).toEqual(
          []
        );
        return summary.runId;
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(catalogRoot)));

      // ---- Third process lifetime: read the persisted Run, read-only. ----
      yield* Effect.gen(function* readOnlyViewer() {
        const viewer = yield* runTool("open_run", { runId });
        expect(viewer.summary.coverage.complete).toBe(true);
        expect(viewer.summary.assessmentCounts.working).toBe(3);
        expect(viewer.viewUrl).not.toContain("session=");
        // Reading evidence reopens no browser.
        expect((yield* sessionTool("agent_sessions_get", {})).sessions).toEqual(
          []
        );
      }).pipe(Effect.scoped, Effect.provide(agentProcessLayer(catalogRoot)));

      // Run artifacts are one self-contained local package. Nothing left this
      // machine: the only paths anyone was handed are inside the Catalog Root.
      const runDirectory = path.join(catalogRoot, AGENT_RUNS_DIRECTORY, runId);
      const runFiles = yield* fileSystem.readDirectory(runDirectory);
      const video = runFiles.find((file) => file.endsWith(".webm"));
      expect(video).toBeDefined();
      expect(
        Number(
          (yield* fileSystem.stat(path.join(runDirectory, video ?? ""))).size
        )
      ).toBeGreaterThan(0);

      // No literal reached any durable artifact of the whole journey.
      const durable = yield* fileSystem.readDirectory(catalogRoot, {
        recursive: true,
      });
      const texts = yield* Effect.forEach(
        durable.filter((entry) => entry.endsWith(".json")),
        (entry) =>
          fileSystem
            .readFileString(path.join(catalogRoot, entry))
            .pipe(Effect.orElseSucceed(() => ""))
      );
      for (const literal of literals) {
        expect(texts.join("\n")).not.toContain(literal);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

/**
 * Teach, verify, and approve one two-Step public journey. It exists so the
 * lifecycle fixtures below have a real Approved Agent Flow to run without
 * repeating the private-Variable journey above.
 */
const approveSanityFlow = (loginUrl: string, fixtureHost: string) =>
  Effect.gen(function* teachSanityFlow() {
    const user = yield* agentView;
    const teaching = yield* sessionTool("agent_session_start", {
      activity: "teaching",
      clientName: "fixture-agent",
      clientVersion: "1.0.0",
      operationId: OperationId.make("fixture-start-teaching"),
      url: loginUrl,
      viewport: agentViewport,
    });
    const observed = yield* sessionTool("agent_browser_snapshot", {
      sessionId: teaching.id,
    });
    yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(observed.nodes, "textbox", "Display name").ref,
        text: "Ada",
        type: "fill",
      },
      operationId: OperationId.make("fixture-fill-display"),
      sessionId: teaching.id,
    });
    yield* sessionTool("agent_browser_act", {
      action: {
        ref: findNode(observed.nodes, "button", "Sign in").ref,
        type: "click",
      },
      operationId: OperationId.make("fixture-click-sign-in"),
      sessionId: teaching.id,
    });
    const feed = yield* flowTool("agent_teaching_feed_get", {
      includeSnapshots: false,
      sessionId: teaching.id,
    });
    const [first, second] = feed.actions;
    if (first === undefined || second === undefined) {
      throw new Error("Teaching lost the demonstrated actions.");
    }
    const saved = yield* flowTool("agent_flow_draft_save", {
      basedOnRevisionId: null,
      draft: {
        description: "Check that the sign-in page still accepts a name.",
        domainScope: { hosts: [fixtureHost] },
        schemaVersion: 1,
        steps: [
          {
            confirmation: false,
            description: "Enter the display name.",
            firstActionId: first.id,
            lastActionId: first.id,
            name: "Enter the display name",
          },
          {
            confirmation: false,
            description: "Sign in.",
            firstActionId: second.id,
            lastActionId: second.id,
            name: "Sign in",
          },
        ],
        title: "Sign-in sanity check",
      },
      operationId: OperationId.make("fixture-save-draft"),
      sessionId: teaching.id,
    });
    const { agentFlowId, revisionId } = saved.manifest;
    yield* user("agent.flow.verification.authorize", {
      data: {
        agentFlowId,
        operationId: OperationId.make("fixture-authorize"),
        revisionId,
      },
      type: "agent.flow.verification.authorize",
    });
    const verifying = yield* flowTool("agent_flow_verification_start", {
      agentFlowId,
      clientName: "fixture-agent",
      clientVersion: "1.0.0",
      operationId: OperationId.make("fixture-verify"),
      revisionId,
    });
    for (const step of saved.manifest.steps) {
      const verificationEvidence = yield* sessionTool(
        "agent_browser_snapshot",
        {
          sessionId: verifying.id,
        }
      );
      yield* runTool("agent_run_step_assess", {
        evidence: [
          {
            id: verificationEvidence.snapshotId,
            kind: "snapshot" as const,
          },
        ],
        explanation: `The "${step.name}" Step reproduced.`,
        operationId: OperationId.make(
          `fixture-assess-verification-${step.index}`
        ),
        outcome: "working",
        sessionId: verifying.id,
      });
    }
    yield* flowTool("agent_flow_verification_complete", {
      operationId: OperationId.make("fixture-verified"),
      outcome: "passed",
      sessionId: verifying.id,
      summary: "The sign-in page still accepts a name.",
    });
    yield* sessionTool("agent_session_close", {
      operationId: OperationId.make("fixture-close-verification"),
      sessionId: verifying.id,
    });
    yield* user("agent.flow.approve", {
      data: {
        agentFlowId,
        operationId: OperationId.make("fixture-approve"),
        revisionId,
      },
      type: "agent.flow.approve",
    });
    yield* sessionTool("agent_session_close", {
      operationId: OperationId.make("fixture-close-teaching"),
      sessionId: teaching.id,
    });
    return { agentFlowId, revisionId };
  });

/**
 * How every way a Run can end releases the browser and the process's temporary
 * resources, and how none of them touches the durable catalog or the Run
 * evidence already on disk
 * ([ADR 0015](../../docs/adr/0015-runs-are-context-isolated-and-end-quiescent.md)).
 */
it.live("releases browsers and temporary resources however a Run ends", () =>
  Effect.gen(function* proveCleanupFixtures() {
    const fileSystem = yield* FileSystem.FileSystem;
    const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-agent-cleanup-",
    });
    const resourceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-agent-owners-",
    });
    const fixtures = yield* fixtureServer;
    const loginUrl = fixtures.url("agent-login.html");
    const fixtureHost = new URL(loginUrl).hostname;

    // A dead owner's leftovers, waiting for the next process to start.
    const staleOwner = path.join(resourceRoot, agentOwnerMarker(40_101));
    yield* fileSystem.makeDirectory(path.join(staleOwner, "session-dead"), {
      recursive: true,
    });
    const ownerMarker = yield* prepareAgentResourceDirectory(resourceRoot);
    // Starting this process scavenged only the dead owner's exact marker.
    expect(yield* fileSystem.exists(staleOwner)).toBe(false);
    expect(yield* fileSystem.exists(ownerMarker)).toBe(true);

    const persisted = yield* Effect.gen(function* runEveryEnding() {
      const approved = yield* approveSanityFlow(loginUrl, fixtureHost);
      // Teaching left no temporary session resources behind.
      expect(yield* fileSystem.readDirectory(ownerMarker)).toEqual([]);

      const startRun = (operationId: string, stepCeilingMs: number) =>
        runTool("agent_flow_run_start", {
          agentFlowId: approved.agentFlowId,
          clientName: "fixture-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make(operationId),
          runCeilingMs: 120_000,
          stepCeilingMs,
        });
      const observe = (sessionId: AgentSessionId, operationId: string) =>
        sessionTool("agent_browser_act", {
          action: { type: "navigate", url: loginUrl },
          operationId: OperationId.make(operationId),
          sessionId,
        });

      // -- Success: every Agent Step reached and assessed. --------------
      const succeeded = yield* startRun("cleanup-success", 60_000);
      for (const index of [0, 1]) {
        const page = yield* observe(succeeded.id, `success-observe-${index}`);
        yield* runTool("agent_run_step_assess", {
          evidence: [{ id: page.snapshot.snapshotId, kind: "snapshot" }],
          explanation: "The page behaved as the Agent Flow describes.",
          operationId: OperationId.make(`success-assess-${index}`),
          outcome: "working",
          sessionId: succeeded.id,
        });
      }
      const successSummary = yield* runTool("agent_run_complete", {
        operationId: OperationId.make("cleanup-complete-success"),
        sessionId: succeeded.id,
        summary: "Both Agent Steps worked.",
      });
      expect(successSummary.outcome).toBe("completed");

      // -- Failure: a terminal Agent Assessment ends the ordered Steps. --
      const failed = yield* startRun("cleanup-failure", 60_000);
      const failurePage = yield* observe(failed.id, "failure-observe");
      yield* runTool("agent_run_step_assess", {
        evidence: [{ id: failurePage.snapshot.snapshotId, kind: "snapshot" }],
        explanation: "The display name field never accepted the name.",
        operationId: OperationId.make("failure-assess"),
        outcome: "not-working",
        sessionId: failed.id,
      });
      const failureSummary = yield* runTool("agent_run_complete", {
        operationId: OperationId.make("cleanup-complete-failure"),
        sessionId: failed.id,
        summary: "The first Agent Step did not work.",
      });
      expect(failureSummary.outcome).toBe("ended-early");
      expect(failureSummary.coverage.complete).toBe(false);

      // -- Timeout: a ceiling ends a Run with an action still in flight. -
      const bounded = yield* startRun("cleanup-timeout", 1000);
      yield* Effect.forkChild(
        sessionTool("agent_browser_act", {
          action: {
            type: "navigate",
            url: `${fixtures.origin}${NEVER_ANSWERED}`,
          },
          operationId: OperationId.make("timeout-hanging-navigate"),
          sessionId: bounded.id,
        }).pipe(Effect.ignore)
      );
      yield* Effect.sleep("4 seconds");
      const timeoutSummary = yield* runTool("agent_run_complete", {
        operationId: OperationId.make("cleanup-complete-timeout"),
        sessionId: bounded.id,
      });
      expect(timeoutSummary.outcome).toBe("timed-out");

      // -- Interruption: the session ends before the Run does. -----------
      const interrupted = yield* startRun("cleanup-interrupted", 60_000);
      yield* observe(interrupted.id, "interrupted-observe");
      const closed = yield* sessionTool("agent_session_close", {
        operationId: OperationId.make("cleanup-close-interrupted"),
        sessionId: interrupted.id,
      });
      expect(closed.phase).toBe("closed");
      expect(requireRun(closed).outcome).toBe("interrupted");
      expect(
        requireRun(closed).steps.map(({ execution }) => execution)
      ).toEqual(["unexecuted", "unexecuted"]);

      // However each Run ended, no browser and no temporary resource
      // outlived it.
      expect((yield* sessionTool("agent_sessions_get", {})).sessions).toEqual(
        []
      );
      expect(yield* fileSystem.readDirectory(ownerMarker)).toEqual([]);
      return {
        agentFlowId: approved.agentFlowId,
        revisionId: approved.revisionId,
        runIds: [
          successSummary.runId,
          failureSummary.runId,
          timeoutSummary.runId,
        ],
      };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        agentProcessLayer(catalogRoot, { resourceDirectory: ownerMarker })
      )
    );

    // Nothing durable was cleaned up with the browsers: a later process
    // still reads the Approved Agent Flow and every persisted Run.
    yield* Effect.gen(function* readDurableEvidence() {
      expect(
        (yield* flowTool("agent_catalog_search", { status: "approved" })).hits
      ).toMatchObject([
        {
          agentFlowId: persisted.agentFlowId,
          revisionId: persisted.revisionId,
        },
      ]);
      for (const runId of persisted.runIds) {
        expect((yield* runTool("open_run", { runId })).summary.runId).toBe(
          runId
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        agentProcessLayer(catalogRoot, { resourceDirectory: ownerMarker })
      )
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
