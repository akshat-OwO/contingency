import path from "node:path";

import {
  AgentElementRef,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { DemoSite } from "../../src/services/demo-site.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
} from "../../src/services/mcp-onboarding.ts";
import {
  agentProcessLayer,
  findNode,
  makeCall,
  resolveBoundary,
  runTool,
  sessionTool,
} from "./agent-harness.ts";
import { draftEmulation } from "./harness.ts";

it.live("renders clickable demo location options in the browser page", () =>
  Effect.gen(function* demoLocationMenus() {
    const browser = yield* CreateBrowser;
    const demo = yield* DemoSite;
    const viewport = { deviceScaleFactor: 1, height: 800, width: 1280 };
    const sessionId = yield* browser.create("create-demo-select", viewport);
    yield* browser.open(
      sessionId,
      demo.origin,
      draftEmulation("default", viewport)
    );
    const { page } = yield* browser.activeTarget(sessionId);
    yield* Effect.promise(async () => {
      await page.getByRole("combobox", { exact: true, name: "City" }).click();
      const city = page.getByRole("option", { exact: true, name: "Golden" });
      // Native OS popups have no option bounds in the captured document.
      expect(await city.boundingBox()).not.toBeNull();
      await city.click();
      await page.getByRole("combobox", { exact: true, name: "Area" }).click();
      const area = page.getByRole("option", {
        exact: true,
        name: "Pleasant View",
      });
      expect(await area.boundingBox()).not.toBeNull();
      await area.click();
      await page
        .getByRole("button", { exact: true, name: "Save location" })
        .click();
      expect(
        await page
          .getByRole("region", { name: "Delivery location" })
          .getByRole("status")
          .textContent()
      ).toBe("Delivering to: Pleasant View, Golden");
      await page.reload();
      expect(
        await page
          .getByRole("combobox", { exact: true, name: "City" })
          .inputValue()
      ).toBe("Golden");
      expect(
        await page
          .getByRole("combobox", { exact: true, name: "Area" })
          .inputValue()
      ).toBe("Pleasant View");
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(CreateBrowserLive, makeDemoSiteLayer()).pipe(
        Layer.provide(NodeServices.layer)
      )
    )
  )
);

const operation = OperationId.make;
const exampleTool = makeCall(OnboardingTools);

const taskRun = (snapshot: AgentSessionSnapshot) => {
  const { run } = snapshot;
  if (run === null || !("schemaVersion" in run)) {
    throw new Error("Expected a task Run.");
  }
  return run;
};

const snapshotText = (sessionId: AgentSessionSnapshot["id"]) =>
  sessionTool("agent_browser_snapshot", { sessionId }).pipe(
    Effect.map((snapshot) => ({
      nodes: snapshot.nodes,
      text: snapshot.nodes
        .map((node) => `${node.role} ${node.name}`)
        .join("\n"),
    }))
  );

const click = (
  sessionId: AgentSessionSnapshot["id"],
  ref: string | undefined,
  id: string
) =>
  sessionTool("agent_browser_act", {
    action: { ref: AgentElementRef.make(ref ?? ""), type: "click" },
    operationId: operation(id),
    sessionId,
  });

it.live(
  "runs bundled Examples on the demo store with Workspace private inputs, isolated faults, and a required scan",
  () =>
    Effect.gen(function* exampleRuns() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-examples-",
      });
      yield* Effect.scoped(
        Effect.gen(function* exerciseExamples() {
          const sessions = yield* AgentSession;

          // Private input: requested by the agent, supplied in Workspace.
          const signedIn = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-signed-in-return"),
            inputs: [
              { name: "order", value: "RH-1057" },
              { name: "reason", value: "Wrong item" },
            ],
            operationId: operation("example-return"),
          });
          const returnRun = taskRun(signedIn);
          expect(returnRun.referencedSkills).toEqual([
            expect.objectContaining({
              flowSkillName: "example-signed-in-return",
              origin: "example",
            }),
          ]);
          expect(returnRun.demoSite).toBe("ridgeline");
          expect(returnRun.requestedTask).toBe(
            "Example: Complete a signed-in task"
          );
          expect(signedIn.currentUrl).toMatch(
            /^http:\/\/ridgeline\.localhost:\d+\/signin\.html$/u
          );
          const requested = yield* sessionTool("agent_variable_request", {
            flowSkillName: FlowSkillName.make("example-signed-in-return"),
            name: "DEMO_PASSWORD",
            operationId: operation("example-password"),
            sessionId: signedIn.id,
          });
          const [decision] = requested.pendingDecisions;
          if (decision === undefined) {
            return yield* Effect.die("Missing the private input request.");
          }
          const secret = "ridgeline-private-1";
          const supplied = yield* sessions.answerDryRunVariable(signedIn.id, {
            decision: "supply",
            operationId: operation("example-password-supply"),
            pendingDecisionId: decision.pendingDecisionId,
            value: secret,
          });
          expect(JSON.stringify(supplied)).not.toContain(secret);
          const form = yield* snapshotText(signedIn.id);
          yield* sessionTool("agent_browser_act", {
            action: {
              ref: AgentElementRef.make(
                findNode(form.nodes, "textbox", "Email").ref ?? ""
              ),
              text: "demo@ridgeline.test",
              type: "fill",
            },
            operationId: operation("example-email"),
            sessionId: signedIn.id,
          });
          yield* sessionTool("agent_variable_enter", {
            flowSkillName: FlowSkillName.make("example-signed-in-return"),
            name: "DEMO_PASSWORD",
            operationId: operation("example-password-enter"),
            ref: AgentElementRef.make(
              findNode(form.nodes, "textbox", "Password").ref ?? ""
            ),
            sessionId: signedIn.id,
          });
          yield* click(
            signedIn.id,
            findNode(form.nodes, "button", "Sign in").ref,
            "example-sign-in"
          );
          const orders = yield* snapshotText(signedIn.id);
          expect(orders.text).toContain("Start a return for RH-1057");
          expect(orders.text).not.toContain(secret);
          yield* click(
            signedIn.id,
            findNode(orders.nodes, "link", "Start a return for RH-1057").ref,
            "example-return-order"
          );
          const returnForm = yield* snapshotText(signedIn.id);
          yield* sessionTool("agent_browser_act", {
            action: {
              ref: AgentElementRef.make(
                findNode(returnForm.nodes, "combobox", "Return reason").ref ??
                  ""
              ),
              type: "select",
              values: ["Wrong item"],
            },
            operationId: operation("example-return-reason"),
            sessionId: signedIn.id,
          });
          const submitReturn = {
            action: {
              ref: AgentElementRef.make(
                findNode(returnForm.nodes, "button", "Submit return").ref ?? ""
              ),
              type: "click" as const,
            },
            intent: { irreversible: true },
            operationId: operation("example-return-submit"),
            sessionId: signedIn.id,
          };
          const confirmation = yield* sessionTool(
            "agent_browser_act",
            submitReturn
          );
          expect(confirmation.intervention?.reason).toBe("confirmation");
          yield* resolveBoundary({
            boundaryId: confirmation.intervention?.id ?? "missing",
            decision: "allow",
            operationId: "example-return-allow",
            sessionId: signedIn.id,
          });
          yield* sessionTool("agent_browser_act", submitReturn);
          const completedReturn = yield* snapshotText(signedIn.id);
          expect(completedReturn.text).toContain("started for order RH-1057");
          expect(completedReturn.text).toContain("Reason: Wrong item");
          yield* runTool("agent_run_complete", {
            operationId: operation("example-return-complete"),
            sessionId: signedIn.id,
          });

          // A fault in one browser context never reaches another.
          const broken = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-broken-cart"),
            inputs: [{ name: "product", value: "Cedar Pull Saw" }],
            operationId: operation("example-broken"),
          });
          const healthy = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-delivery-cart"),
            inputs: [
              { name: "product", value: "Cedar Pull Saw" },
              { name: "city", value: "Denver" },
              { name: "area", value: "Highlands" },
            ],
            operationId: operation("example-healthy"),
          });
          for (const session of [broken, healthy]) {
            const shop = yield* snapshotText(session.id);
            yield* click(
              session.id,
              findNode(shop.nodes, "button", "Add Cedar Pull Saw to cart").ref,
              `add-${session.id}`
            );
          }
          const brokenShop = yield* snapshotText(broken.id);
          expect(brokenShop.text).toContain("Demo fault");
          expect(brokenShop.text).toContain("Cart (empty)");
          const healthyShop = yield* snapshotText(healthy.id);
          expect(healthyShop.text).not.toContain("Demo fault");
          expect(healthyShop.text).toContain("Cart (1)");
          yield* click(
            broken.id,
            findNode(brokenShop.nodes, "button", "Restore healthy store").ref,
            "example-restore"
          );
          const restored = yield* snapshotText(broken.id);
          expect(restored.text).not.toContain("Demo fault");
          for (const session of [broken, healthy]) {
            yield* runTool("agent_run_complete", {
              operationId: operation(`complete-${session.id}`),
              sessionId: session.id,
            });
          }

          // A required scan runs against the Example's Scan Requirement.
          const scanned = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-cart-scan"),
            inputs: [{ name: "product", value: "Garden Trowel" }],
            operationId: operation("example-scan"),
          });
          expect(taskRun(scanned).scanRequirements).toEqual([
            expect.objectContaining({
              flowSkillName: "example-cart-scan",
              id: "cart-accessibility",
              mode: "accessibility",
            }),
          ]);
          const scanShop = yield* snapshotText(scanned.id);
          yield* click(
            scanned.id,
            findNode(scanShop.nodes, "button", "Add Garden Trowel to cart").ref,
            "scan-add"
          );
          const afterAdd = yield* snapshotText(scanned.id);
          yield* click(
            scanned.id,
            findNode(afterAdd.nodes, "link", "Cart").ref,
            "scan-cart"
          );
          const reported = yield* runTool("agent_run_scan", {
            action: "start",
            flowSkillName: FlowSkillName.make("example-cart-scan"),
            operationId: operation("scan-start"),
            requirementId: "cart-accessibility",
            sessionId: scanned.id,
          });
          const report = taskRun(reported).scanReports?.at(-1);
          expect(report).toMatchObject({
            mode: "accessibility",
            requirementId: "cart-accessibility",
            status: "completed",
          });
          const reportFile = yield* files.readFileString(
            path.join(
              root,
              "agent-runs",
              taskRun(reported).runId,
              report?.reportPath ?? ""
            )
          );
          // The store's one documented finding is the low-contrast note.
          expect(reportFile).toContain("color-contrast");
          yield* runTool("agent_run_complete", {
            operationId: operation("scan-complete"),
            sessionId: scanned.id,
          });
        })
      ).pipe(
        Effect.provide(
          OnboardingToolHandlersLive.pipe(
            Layer.provideMerge(makeDemoSiteLayer()),
            Layer.provideMerge(agentProcessLayer(root))
          )
        )
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
