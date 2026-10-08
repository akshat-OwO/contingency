import {
  AgentPursuitResult,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";

import { AgentSession } from "../../src/services/agent-session.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import {
  OnboardingToolHandlersLive,
  OnboardingTools,
} from "../../src/services/mcp-onboarding.ts";
import {
  PursuitToolHandlersLive,
  PursuitTools,
} from "../../src/services/mcp-pursuit.ts";
import type {
  SystemOneRequest,
  SystemOneResponse,
} from "../../src/services/system-one-request.ts";
import { SystemOne, SystemOneError } from "../../src/services/system-one.ts";
import { agentProcessLayer, makeCall, runTool } from "./agent-harness.ts";

const operation = OperationId.make;
const exampleTool = makeCall(OnboardingTools);
const pursueTool = makeCall(PursuitTools, "agent");

type Questions = Omit<SystemOneRequest, "model">;
type Answer = (request: Questions) => SystemOneResponse | "fail";

/** The answerer the current Pursuit is scripted with. */
interface Script {
  answer: Answer;
}

/**
 * A scripted System One. Each Pursuit installs the answerer it needs, and
 * every request is kept so a test can read exactly what left Contingency.
 */
const scripted = () => {
  const requests: Questions[] = [];
  const state: Script = {
    answer: () => {
      throw new Error("No System One answer was scripted.");
    },
  };
  const layer = Layer.succeed(SystemOne, {
    ask: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        const response = state.answer(request);
        return response === "fail"
          ? Effect.fail(new SystemOneError({ message: "Endpoint offline." }))
          : Effect.succeed(response);
      }),
    first: false,
  });
  return { layer, requests, state };
};

const respond = (answers: SystemOneResponse["answers"]): SystemOneResponse => ({
  answers,
  model: "scripted",
  usage: { input_tokens: 0, output_tokens: 0 },
});
const choice = (picked: string, confidence = 0.95) => ({
  choice: picked,
  confidence,
  probabilities: { [picked]: confidence },
  type: "choice" as const,
});
const noul = (value: number) => ({ noul: value, type: "noul" as const });

/** The index System One names an element by, found by role and name. */
const indexOf = (request: Questions, role: string, name: string) => {
  const found = request.state.elements.find(
    (element) => element.role === role && element.name.includes(name)
  );
  if (found === undefined) {
    throw new Error(`No ${role} named ${name} in the request.`);
  }
  return found.index;
};
const pageShows = (request: Questions, text: string) =>
  request.state.page.content.some((line) => line.includes(text));

const pursue = (
  sessionId: AgentSessionId,
  id: string,
  extra: Partial<Parameters<typeof pursueTool<"agent_browser_pursue">>[1]> = {}
) =>
  pursueTool("agent_browser_pursue", {
    doneWhen: "The status line reads that Trail Hammer was added to cart.",
    goal: 'In "Products", select "Add Trail Hammer to cart".',
    operationId: operation(id),
    sessionId,
    ...extra,
  }).pipe(
    Effect.flatMap((answer) =>
      Schema.decodeUnknownEffect(AgentPursuitResult)(answer).pipe(Effect.orDie)
    )
  );

const addTrailHammer: Answer = (request) =>
  respond({
    click_target: choice(
      indexOf(request, "button", "Add Trail Hammer to cart")
    ),
    // Below the 0.9 needed before the first action, so the Pursuit acts.
    done: noul(pageShows(request, "Trail Hammer added to cart") ? 0.97 : 0.6),
    operation: choice("CLICK"),
  });

it.live(
  "pursues delegated sub-goals on the demo store and records them on the Run",
  () =>
    Effect.gen(function* pursueSubGoals() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-pursuit-",
      });
      const systemOne = scripted();
      yield* Effect.scoped(
        Effect.gen(function* exercisePursuits() {
          const started = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-delivery-cart"),
            inputs: [
              { name: "product", value: "Trail Hammer" },
              { name: "city", value: "Denver" },
              { name: "area", value: "Highlands" },
            ],
            operationId: operation("pursuit-start"),
          });
          const sessionId = started.id;

          // A sub-goal whose literal outcome is half-likely before acting
          // still acts, then ends done once the Page shows it.
          systemOne.state.answer = addTrailHammer;
          const added = yield* pursue(sessionId, "pursuit-add");
          expect(added.ending).toBe("done");
          expect(added.actions).toHaveLength(1);
          expect(added.actions[0]?.entry.dispatched).toBe(true);
          expect(added.actions[0]?.operationId).toBe("pursuit-add/1");
          expect(added.actions[0]?.confidence).toEqual({
            operation: 0.95,
            target: 0.95,
            value: null,
          });
          expect(added.snapshot?.text).toContain("Trail Hammer added to cart");
          const asked = systemOne.requests.length;

          // The same operation id replays without asking or acting again.
          const replayed = yield* pursue(sessionId, "pursuit-add");
          expect(replayed.actions.map((action) => action.entry.id)).toEqual(
            added.actions.map((action) => action.entry.id)
          );
          expect(systemOne.requests).toHaveLength(asked);
          const reused = yield* Effect.flip(
            pursue(sessionId, "pursuit-add", { goal: "Open the cart." })
          );
          expect(reused.code).toBe("agent_session_conflict");

          // Ordinary inputs travel by value and fill list fields.
          systemOne.state.answer = (request) => {
            const city = request.state.elements.find(
              (element) => element.name === "City"
            );
            const area = request.state.elements.find(
              (element) => element.name === "Area"
            );
            if (pageShows(request, "Delivering to: Highlands, Denver")) {
              return respond({ done: noul(0.96), operation: choice("CLICK") });
            }
            if (city?.value !== "Denver") {
              return respond({
                done: noul(0.05),
                operation: choice("SELECT"),
                select_target: choice(city?.index ?? "0"),
                [`value_${city?.index}`]: choice("city"),
              });
            }
            if (area?.value !== "Highlands") {
              return respond({
                done: noul(0.05),
                operation: choice("SELECT"),
                select_target: choice(area?.index ?? "0"),
                [`value_${area?.index}`]: choice("area"),
              });
            }
            return respond({
              click_target: choice(indexOf(request, "button", "Save location")),
              done: noul(0.05),
              operation: choice("CLICK"),
            });
          };
          const located = yield* pursue(sessionId, "pursuit-location", {
            doneWhen:
              'The status line reads "Delivering to: Highlands, Denver".',
            goal: "Choose Denver in City and Highlands in Area, then select Save location.",
          });
          expect(located.ending).toBe("done");
          expect(
            located.actions.map((action) => action.entry.description)
          ).toEqual([
            expect.stringContaining("Denver"),
            expect.stringContaining("Highlands"),
            expect.stringContaining("Save location"),
          ]);
          expect(located.actions[0]?.confidence.value).toBe(0.95);
          const [locationRequest] = systemOne.requests.slice(asked);
          expect(JSON.stringify(locationRequest?.questions)).toContain(
            '"city":"Denver"'
          );

          // BLOCKED and a low-confidence answer act on nothing.
          systemOne.state.answer = () =>
            respond({ done: noul(0.1), operation: choice("BLOCKED", 0.8) });
          const blocked = yield* pursue(sessionId, "pursuit-blocked");
          expect(blocked.ending).toBe("blocked");
          expect(blocked.actions).toHaveLength(0);
          systemOne.state.answer = (request) =>
            respond({
              click_target: choice(indexOf(request, "link", "Cart")),
              done: noul(0.1),
              operation: choice("CLICK", 0.4),
            });
          const unsure = yield* pursue(sessionId, "pursuit-unsure");
          expect(unsure.ending).toBe("unsure");
          expect(unsure.actions).toHaveLength(0);
          expect(unsure.reason).toContain("0.40");

          // A spent action budget ends unsure after the allowed actions.
          systemOne.state.answer = (request) =>
            respond({
              click_target: choice(
                indexOf(request, "button", "Add Trail Hammer to cart")
              ),
              done: noul(0.1),
              operation: choice("CLICK"),
            });
          const budget = yield* pursue(sessionId, "pursuit-budget", {
            maxActions: 1,
          });
          expect(budget.ending).toBe("unsure");
          expect(budget.actions).toHaveLength(1);
          expect(budget.reason).toContain("1-action budget");

          // The same action a third time in a row is a loop, not progress.
          const looped = yield* pursue(sessionId, "pursuit-loop");
          expect(looped.ending).toBe("unsure");
          expect(looped.actions).toHaveLength(2);
          expect(looped.reason).toContain("a third time in a row");

          // Only System One itself failing fails the call.
          systemOne.state.answer = () => "fail";
          const failed = yield* Effect.flip(
            pursue(sessionId, "pursuit-offline")
          );
          expect(failed.code).toBe("system_one_failed");
          expect(failed.message).toContain("No action was taken");

          // Confirmation still pauses a model-chosen action.
          systemOne.state.answer = (request) =>
            respond({
              click_target: choice(
                indexOf(request, "button", "Add Cedar Pull Saw to cart")
              ),
              done: noul(0.1),
              operation: choice("CLICK"),
            });
          const confirmed = yield* pursue(sessionId, "pursuit-confirm", {
            doneWhen: "The status line reads that Cedar Pull Saw was added.",
            goal: 'Select "Add Cedar Pull Saw to cart".',
            irreversible: true,
          });
          expect(confirmed.ending).toBe("paused");
          expect(confirmed.intervention?.reason).toBe("confirmation");
          expect(confirmed.actions[0]?.entry.dispatched).toBe(false);

          const summary = yield* runTool("agent_run_complete", {
            operationId: operation("pursuit-complete"),
            sessionId,
          });
          if (!("schemaVersion" in summary) || summary.schemaVersion !== 3) {
            return yield* Effect.die("Expected a task Run Summary.");
          }
          expect(summary.pursuits?.map((pursuit) => pursuit.ending)).toEqual([
            "done",
            "done",
            "blocked",
            "unsure",
            "unsure",
            "unsure",
            "paused",
          ]);
          const [first] = summary.pursuits ?? [];
          expect(first?.actions[0]?.attemptId).toBe(added.actions[0]?.entry.id);
          expect(
            summary.timeline.some((entry) =>
              entry.description.startsWith("Pursuit ended done")
            )
          ).toBe(true);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              OnboardingToolHandlersLive,
              PursuitToolHandlersLive.pipe(Layer.provide(systemOne.layer))
            ).pipe(
              Layer.provideMerge(makeDemoSiteLayer()),
              Layer.provideMerge(agentProcessLayer(root))
            )
          )
        )
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it.live(
  "sends a private Variable by name and asks for it when it has no value",
  () =>
    Effect.gen(function* pursuePrivateInput() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-pursuit-secret-",
      });
      const systemOne = scripted();
      yield* Effect.scoped(
        Effect.gen(function* exercisePrivateInput() {
          const sessions = yield* AgentSession;
          const flowSkillName = FlowSkillName.make("example-signed-in-return");
          const started = yield* exampleTool("agent_example_run_start", {
            example: flowSkillName,
            inputs: [
              { name: "order", value: "RH-1057" },
              { name: "reason", value: "Wrong item" },
            ],
            operationId: operation("secret-start"),
          });
          const sessionId = started.id;
          systemOne.state.answer = (request) => {
            if (request.state.recent_actions.length > 0) {
              return respond({ done: noul(0.95), operation: choice("CLICK") });
            }
            const password = indexOf(request, "textbox", "Password");
            return respond({
              done: noul(0.05),
              fill_target: choice(password),
              operation: choice("FILL"),
              [`value_${password}`]: choice("DEMO_PASSWORD"),
            });
          };
          const goal = {
            doneWhen: "The Password field holds the password.",
            flowSkillName,
            goal: "Enter the demo password in Password.",
          };
          const waiting = yield* pursue(sessionId, "secret-first", goal);
          expect(waiting.ending).toBe("needs-input");
          expect(waiting.missingVariable).toEqual({
            flowSkillName,
            name: "DEMO_PASSWORD",
          });

          const asked = yield* sessions.requestTaskVariable(
            sessionId,
            flowSkillName,
            "DEMO_PASSWORD",
            operation("secret-request")
          );
          const [decision] = asked.pendingDecisions;
          if (decision === undefined) {
            return yield* Effect.die("Missing the private input request.");
          }
          const secret = "ridgeline-private-1";
          yield* sessions.answerDryRunVariable(sessionId, {
            decision: "supply",
            operationId: operation("secret-supply"),
            pendingDecisionId: decision.pendingDecisionId,
            value: secret,
          });
          const entered = yield* pursue(sessionId, "secret-second", goal);
          expect(entered.ending).toBe("done");
          expect(entered.actions[0]?.variable).toBe("DEMO_PASSWORD");
          expect(JSON.stringify(entered)).not.toContain(secret);
          const sent = JSON.stringify(systemOne.requests);
          expect(sent).not.toContain(secret);
          expect(sent).toContain("the private Variable DEMO_PASSWORD");
          expect(sent).toContain('"order":"RH-1057"');
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              OnboardingToolHandlersLive,
              PursuitToolHandlersLive.pipe(Layer.provide(systemOne.layer))
            ).pipe(
              Layer.provideMerge(makeDemoSiteLayer()),
              Layer.provideMerge(agentProcessLayer(root))
            )
          )
        )
      );
    }).pipe(Effect.provide(NodeServices.layer))
);
