import path from "node:path";

import { OperationId } from "@contingency/protocol";
import type {
  AgentFlowDiagnostic,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Result, Stream } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";

import {
  AgentFlowCatalog,
  makeAgentFlowCatalogLayer,
} from "../../src/services/agent-flow-catalog.ts";
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
  AgentSessionToolHandlersLive,
  AgentSessionTools,
} from "../../src/services/mcp-agent-session.ts";
import { fixtureServer } from "./harness.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

interface ToolFailure {
  readonly code: string;
  readonly diagnostics?: readonly AgentFlowDiagnostic[];
  readonly message: string;
}

const isToolFailure = (value: unknown): value is ToolFailure =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  "message" in value;

const makeCall =
  <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>) =>
  <Name extends keyof Tools>(
    name: Name,
    params: Tool.Parameters<Tools[Name]>
  ) =>
    Effect.gen(function* callTool() {
      const handlers = yield* toolkit;
      const results = yield* handlers
        .handle(name, params)
        .pipe(Effect.orDie, Effect.flatMap(Stream.runCollect));
      const last = results.at(-1);
      if (last === undefined) {
        return yield* Effect.die(`The ${String(name)} tool answered nothing.`);
      }
      const { result } = last;
      if (isToolFailure(result)) {
        return yield* Effect.fail(result);
      }
      return result as Tool.Success<Tools[Name]>;
    });

const session = makeCall(AgentSessionTools);
const flow = makeCall(AgentFlowTools);

const findNode = (
  nodes: readonly AgentSnapshotNode[],
  role: string,
  name: string
): AgentSnapshotNode => {
  const found = nodes.find(
    (node) => node.role === role && node.name.includes(name)
  );
  if (found === undefined) {
    throw new Error(
      `The Browser Snapshot had no ${role} named ${name}: ${nodes
        .map((node) => `${node.role}/${node.name}`)
        .join(", ")}`
    );
  }
  return found;
};

const verificationLayer = (catalogRoot: string) =>
  Layer.mergeAll(AgentSessionToolHandlersLive, AgentFlowToolHandlersLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        makeAgentSessionLayer({
          baseUrl: "http://127.0.0.1:7777",
          traceDirectory: () => path.join(catalogRoot, "sessions"),
        }),
        makeAgentFlowCatalogLayer({ root: catalogRoot })
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );

/**
 * The whole review-verify-approve boundary over one real Chromium: the agent
 * teaches a private-input login, only Agent View can authorize verification,
 * the Verification Run opens a fresh context that knows nothing Teaching
 * prepared and asks for the runtime Variable again, and only Agent View turns
 * the verified revision into an Approved Agent Flow
 * ([ADR 0027](../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
it.live(
  "verifies a private-input login draft in a fresh context and refuses MCP self-approval",
  () =>
    Effect.gen(function* verifyPrivateLogin() {
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-verification-",
      });
      yield* Effect.gen(function* verify() {
        const fixtures = yield* fixtureServer;
        const loginUrl = fixtures.url("agent-login.html");
        const fixtureHost = new URL(loginUrl).hostname;
        const localSession = yield* AgentSession;
        const catalog = yield* AgentFlowCatalog;

        // No MCP tool can authorize verification or approve a revision.
        const toolNames = [
          ...Object.keys(AgentFlowTools.tools),
          ...Object.keys(AgentSessionTools.tools),
        ];
        expect(
          toolNames.filter((name) => /approve|authoriz/u.test(name))
        ).toEqual([]);

        // Teaching: the user types the password privately, so only the
        // declaration is captured.
        const taught = yield* session("agent_session_start", {
          activity: "teaching",
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("start-teaching"),
          url: loginUrl,
          viewport,
        });
        const observed = yield* session("agent_browser_snapshot", {
          sessionId: taught.id,
        });
        const password = findNode(observed.nodes, "textbox", "Password");
        const signIn = findNode(observed.nodes, "button", "Sign in");
        yield* flow("agent_teaching_instruction_record", {
          operationId: OperationId.make("instruct-login"),
          sessionId: taught.id,
          text: "Sign in with my password.",
        });
        const taughtLiteral = "taught-secret-value";
        const entered = yield* session("agent_teaching_variable_input", {
          operationId: OperationId.make("enter-password"),
          ref: password.ref,
          sessionId: taught.id,
          value: taughtLiteral,
          variable: { name: "PASSWORD", runtime: true, secret: true },
        });
        const clicked = yield* session("agent_browser_act", {
          action: { ref: signIn.ref, type: "click" },
          operationId: OperationId.make("click-sign-in"),
          sessionId: taught.id,
        });
        expect(entered.snapshot.snapshotId).not.toBe(
          clicked.snapshot.snapshotId
        );

        const feed = yield* flow("agent_teaching_feed_get", {
          includeSnapshots: false,
          sessionId: taught.id,
        });
        expect(JSON.stringify(feed)).not.toContain(taughtLiteral);
        expect(feed.variables).toEqual([
          { name: "PASSWORD", runtime: true, secret: true },
        ]);
        const [fillAction, clickAction] = feed.actions;
        if (fillAction === undefined || clickAction === undefined) {
          throw new Error("Teaching lost the demonstrated actions.");
        }

        const saved = yield* flow("agent_flow_draft_save", {
          basedOnRevisionId: null,
          draft: {
            description: "Sign in with the account password.",
            domainScope: { hosts: [fixtureHost] },
            schemaVersion: 1,
            steps: [
              {
                confirmation: false,
                description: "Enter the password and sign in.",
                firstActionId: fillAction.id,
                lastActionId: clickAction.id,
                name: "Sign in",
              },
            ],
            title: "Private login",
            variables: feed.variables,
          },
          operationId: OperationId.make("save-draft"),
          sessionId: taught.id,
        });
        const { agentFlowId, revisionId } = saved.manifest;

        // The agent cannot fund its own Verification Run.
        const unauthorized = yield* Effect.flip(
          flow("agent_flow_verification_start", {
            agentFlowId,
            clientName: "integration-agent",
            clientVersion: "1.0.0",
            operationId: OperationId.make("start-unauthorized"),
            revisionId,
          })
        );
        expect(unauthorized.code).toBe("agent_flow_conflict");
        // Nor approve an unverified draft: approval has no tool at all, and
        // the catalog refuses the write behind it.
        const unverified = yield* Effect.flip(
          catalog.approve({
            agentFlowId,
            operationId: OperationId.make("approve-unverified"),
            revisionId,
          })
        );
        expect(unverified.code).toBe("agent_flow_conflict");

        // Agent View authorizes this one exact revision.
        const authorized = yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("authorize-run"),
          revisionId,
        });
        expect(authorized.heads.verification).toMatchObject({
          revisionId,
          status: "authorized",
        });

        const run = yield* flow("agent_flow_verification_start", {
          agentFlowId,
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("start-run"),
          revisionId,
        });
        expect(run.id).not.toBe(taught.id);
        expect(run.activity).toBe("run");
        expect(run.teaching).toBeNull();
        expect(run.verification).toMatchObject({
          agentFlowId,
          outcome: null,
          revisionId,
          variables: [
            { name: "PASSWORD", runtime: true, secret: true, supplied: false },
          ],
        });
        // The authorization is spent: a second Run needs another gesture.
        const spent = yield* Effect.flip(
          flow("agent_flow_verification_start", {
            agentFlowId,
            clientName: "integration-agent",
            clientVersion: "1.0.0",
            operationId: OperationId.make("start-again"),
            revisionId,
          })
        );
        expect(spent.code).toBe("agent_flow_conflict");

        // The fresh context inherits nothing Teaching prepared.
        const navigated = yield* session("agent_browser_act", {
          action: { type: "navigate", url: loginUrl },
          operationId: OperationId.make("run-navigate"),
          sessionId: run.id,
        });
        const runPassword = findNode(
          navigated.snapshot.nodes,
          "textbox",
          "Password"
        );
        const echo = navigated.snapshot.nodes.find(
          (node) => node.role === "status" || node.role === "output"
        );
        expect(echo?.name ?? "").not.toContain(taughtLiteral);

        // The agent may not enter a Variable the user has not supplied.
        const missing = yield* Effect.flip(
          session("agent_variable_enter", {
            name: "PASSWORD",
            operationId: OperationId.make("enter-before-supply"),
            ref: runPassword.ref,
            sessionId: run.id,
          })
        );
        expect(missing.code).toBe("agent_session_invalid");
        const undeclared = yield* Effect.flip(
          localSession.supplyVariable(
            run.id,
            "UNDECLARED",
            "nope",
            OperationId.make("supply-undeclared")
          )
        );
        expect(undeclared.code).toBe("agent_session_invalid");

        // Agent View supplies the runtime Variable again, from scratch.
        const runLiteral = "run-secret-value";
        const supplied = yield* localSession.supplyVariable(
          run.id,
          "PASSWORD",
          runLiteral,
          OperationId.make("supply-password")
        );
        expect(supplied.verification?.variables).toEqual([
          { name: "PASSWORD", runtime: true, secret: true, supplied: true },
        ]);
        expect(JSON.stringify(supplied)).not.toContain(runLiteral);

        const filled = yield* session("agent_variable_enter", {
          name: "PASSWORD",
          operationId: OperationId.make("enter-password-run"),
          ref: runPassword.ref,
          sessionId: run.id,
        });
        expect(JSON.stringify(filled)).not.toContain(runLiteral);
        expect(
          findNode(filled.snapshot.nodes, "textbox", "Password").value
        ).not.toBe(runLiteral);

        // A failed verification records evidence and approves nothing.
        const failedRun = yield* flow("agent_flow_verification_complete", {
          operationId: OperationId.make("complete-failed"),
          outcome: "failed",
          sessionId: run.id,
          summary: "The sign-in button did not confirm the session.",
        });
        expect(failedRun.heads.verification).toMatchObject({
          revisionId,
          status: "failed",
        });
        expect(failedRun.heads.approvedRevisionId).toBeNull();
        const refusedApproval = yield* Effect.flip(
          catalog.approve({
            agentFlowId,
            operationId: OperationId.make("approve-failed"),
            revisionId,
          })
        );
        expect(refusedApproval.code).toBe("agent_flow_conflict");
        yield* session("agent_session_close", {
          operationId: OperationId.make("close-failed-run"),
          sessionId: run.id,
        });

        // The user authorizes once more, and then the agent proposes a changed
        // draft: the authorization covered one exact revision and does not
        // travel to the correction.
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("authorize-again"),
          revisionId,
        });
        const corrected = yield* flow("agent_flow_draft_save", {
          agentFlowId,
          basedOnRevisionId: revisionId,
          draft: {
            description: "Sign in with the account password.",
            domainScope: { hosts: [fixtureHost] },
            schemaVersion: 1,
            steps: [
              {
                confirmation: true,
                description: "Enter the password, then confirm the sign-in.",
                firstActionId: fillAction.id,
                lastActionId: clickAction.id,
                name: "Sign in and confirm",
              },
            ],
            title: "Private login",
            variables: feed.variables,
          },
          operationId: OperationId.make("save-corrected-draft"),
          sessionId: taught.id,
        });
        const correctedRevisionId = corrected.manifest.revisionId;
        expect(correctedRevisionId).not.toBe(revisionId);
        expect(corrected.heads.verification).toBeNull();
        for (const stale of [revisionId, correctedRevisionId]) {
          const unfunded = yield* Effect.flip(
            flow("agent_flow_verification_start", {
              agentFlowId,
              clientName: "integration-agent",
              clientVersion: "1.0.0",
              operationId: OperationId.make(`start-after-change-${stale}`),
              revisionId: stale,
            })
          );
          expect(unfunded.code).toBe("agent_flow_conflict");
        }

        // Another direct authorization, of the changed draft this time.
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("authorize-corrected"),
          revisionId: correctedRevisionId,
        });
        const retry = yield* flow("agent_flow_verification_start", {
          agentFlowId,
          clientName: "integration-agent",
          clientVersion: "1.0.0",
          operationId: OperationId.make("start-retry"),
          revisionId: correctedRevisionId,
        });
        expect(retry.id).not.toBe(run.id);
        expect(retry.verification?.variables).toEqual([
          { name: "PASSWORD", runtime: true, secret: true, supplied: false },
        ]);
        const passed = yield* flow("agent_flow_verification_complete", {
          operationId: OperationId.make("complete-passed"),
          outcome: "passed",
          sessionId: retry.id,
          summary: "The password was accepted and the page confirmed sign-in.",
        });
        expect(passed.heads.verification).toMatchObject({
          revisionId: correctedRevisionId,
          status: "passed",
        });
        expect(passed.heads.approvedRevisionId).toBeNull();
        yield* session("agent_session_close", {
          operationId: OperationId.make("close-retry-run"),
          sessionId: retry.id,
        });

        // Only Agent View turns the verified revision into an Approved Agent
        // Flow, and the gesture is idempotent by operation id.
        const approved = yield* catalog.approve({
          agentFlowId,
          operationId: OperationId.make("approve-verified"),
          revisionId: correctedRevisionId,
        });
        expect(approved.manifest.status).toBe("approved");
        expect(approved.manifest.steps[0]?.name).toBe("Sign in and confirm");
        expect(approved.heads.approvedRevisionId).toBe(correctedRevisionId);
        expect(approved.heads.draftRevisionId).toBeNull();
        const replayed = yield* catalog.approve({
          agentFlowId,
          operationId: OperationId.make("approve-verified"),
          revisionId: correctedRevisionId,
        });
        expect(replayed).toEqual(approved);
        const found = yield* flow("agent_catalog_search", {
          status: "approved",
        });
        expect(found.hits).toMatchObject([{ agentFlowId, status: "approved" }]);

        // Two edits of the Approved Agent Flow start from the same immutable
        // approved head. One becomes the new draft; the other gets a conflict.
        const edit = (operationId: string, title: string) =>
          flow("agent_flow_draft_save", {
            agentFlowId,
            basedOnRevisionId: correctedRevisionId,
            draft: {
              description: "Sign in with the account password.",
              domainScope: { hosts: [fixtureHost] },
              schemaVersion: 1 as const,
              steps: [
                {
                  confirmation: true,
                  description: "Enter the password, then confirm the sign-in.",
                  firstActionId: fillAction.id,
                  lastActionId: clickAction.id,
                  name: title,
                },
              ],
              title,
              variables: feed.variables,
            },
            operationId: OperationId.make(operationId),
            sessionId: taught.id,
          });
        const edits = yield* Effect.all(
          [
            Effect.result(edit("edit-approved-left", "Private login left")),
            Effect.result(edit("edit-approved-right", "Private login right")),
          ],
          { concurrency: "unbounded" }
        );
        expect(edits.filter(Result.isSuccess)).toHaveLength(1);
        const conflict = edits.find(Result.isFailure);
        expect(conflict?.failure.code).toBe("agent_flow_conflict");
        const afterEdit = yield* catalog.get(agentFlowId);
        expect(afterEdit.heads.approvedRevisionId).toBe(correctedRevisionId);
        expect(afterEdit.heads.draftRevisionId).not.toBeNull();
        expect(
          (yield* catalog.get(agentFlowId, correctedRevisionId)).manifest.status
        ).toBe("approved");
        expect(
          (yield* flow("agent_catalog_search", { status: "approved" })).hits
        ).toMatchObject([{ revisionId: correctedRevisionId }]);

        // No literal reached the persisted package.
        const persisted = yield* fileSystem.readFileString(
          path.join(
            catalogRoot,
            "agent-flows",
            agentFlowId,
            "revisions",
            correctedRevisionId,
            "manifest.json"
          )
        );
        expect(persisted).not.toContain(taughtLiteral);
        expect(persisted).not.toContain(runLiteral);

        yield* session("agent_session_close", {
          operationId: OperationId.make("close-teaching"),
          sessionId: taught.id,
        });
        const retainedFiles = yield* fileSystem.readDirectory(
          path.join(catalogRoot, "sessions"),
          { recursive: true }
        );
        expect(
          retainedFiles.some(
            (file) => file.endsWith(".zip") || file.endsWith(".webm")
          )
        ).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(verificationLayer(catalogRoot)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
