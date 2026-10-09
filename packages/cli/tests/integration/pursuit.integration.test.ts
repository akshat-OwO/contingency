import {
  AgentPursuitResult,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";

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
type Answer = (request: Questions) => SystemOneResponse | "fail" | "hang";

/** The answerer the current Pursuit is scripted with. */
interface Script {
  answer: Answer;
  /** Completed with the request left unanswered. */
  hung: Deferred.Deferred<Questions>;
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
    hung: Deferred.makeUnsafe<Questions>(),
  };
  const layer = Layer.succeed(SystemOne, {
    ask: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        const response = state.answer(request);
        if (response === "hang") {
          return Deferred.succeed(state.hung, request).pipe(
            Effect.andThen(Effect.never)
          );
        }
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

interface PursueOptions {
  readonly doneWhen?: string;
  readonly flowSkillName?: FlowSkillName;
  readonly goal?: string;
  readonly irreversible?: boolean;
  readonly maxActions?: number;
  readonly steps?: readonly {
    readonly doneWhen: string;
    readonly goal: string;
  }[];
}

/** One call; a lone goal and doneWhen make a single step. */
const pursue = (
  sessionId: AgentSessionId,
  id: string,
  {
    doneWhen = "The status line reads that Trail Hammer was added to cart.",
    goal = 'In "Products", select "Add Trail Hammer to cart".',
    steps,
    ...rest
  }: PursueOptions = {}
) =>
  pursueTool("agent_browser_pursue", {
    operationId: operation(id),
    sessionId,
    steps: steps ?? [{ doneWhen, goal }],
    ...rest,
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

it.live("confirms quoted text only when the step brought it about", () =>
  Effect.gen(function* pursueQuotedChange() {
    const files = yield* FileSystem.FileSystem;
    const root = yield* files.makeTempDirectoryScoped({
      prefix: "contingency-pursuit-quoted-",
    });
    const systemOne = scripted();
    yield* Effect.scoped(
      Effect.gen(function* exerciseQuotedChange() {
        const started = yield* exampleTool("agent_example_run_start", {
          example: FlowSkillName.make("example-delivery-cart"),
          inputs: [
            { name: "product", value: "Trail Hammer" },
            { name: "city", value: "Denver" },
            { name: "area", value: "Highlands" },
          ],
          operationId: operation("quoted-start"),
        });
        const clicking =
          (name: string): Answer =>
          (request) =>
            respond({
              click_target: choice(indexOf(request, "button", name)),
              done: noul(0.1),
              operation: choice("CLICK"),
            });

        // "Trail Hammer" is a product name from the start, so a wrong
        // click does not make the step done.
        systemOne.state.answer = clicking("Add Cedar Pull Saw to cart");
        const wrong = yield* pursue(started.id, "quoted-wrong", {
          doneWhen: 'The status line names "Trail Hammer".',
          maxActions: 1,
        });
        expect(wrong.ending).toBe("unsure");
        expect(wrong.actions).toHaveLength(1);
        expect(wrong.snapshot?.text).toContain("Cedar Pull Saw added");

        // Text that appears only after the action still settles the step,
        // even when System One doubts it.
        systemOne.state.answer = clicking("Add Trail Hammer to cart");
        const added = yield* pursue(started.id, "quoted-added", {
          doneWhen: 'The status line reads "Trail Hammer added to cart".',
        });
        expect(added.ending).toBe("done");
        expect(added.actions).toHaveLength(1);
        expect(added.reason).toBe("The Page shows what doneWhen describes.");
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

/** The step a question asks about, from its instruction text. */
const stepOf = (request: Questions, prefix: string) => {
  const question = request.questions[`${prefix}operation`];
  return question?.type === "choice" ? question.instructions.step : undefined;
};

it.live(
  "pursues several steps in one call and starts the next from the same answer",
  () =>
    Effect.gen(function* pursueSteps() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-pursuit-steps-",
      });
      const systemOne = scripted();
      yield* Effect.scoped(
        Effect.gen(function* exerciseSteps() {
          const started = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-delivery-cart"),
            inputs: [
              { name: "product", value: "Trail Hammer" },
              { name: "city", value: "Denver" },
              { name: "area", value: "Highlands" },
            ],
            operationId: operation("steps-start"),
          });
          // Each prefix answers its own step: add the hammer, or open the cart.
          systemOne.state.answer = (request) => {
            const answers: Record<
              string,
              SystemOneResponse["answers"][string]
            > = {};
            for (const prefix of ["", "next_"]) {
              const step = stepOf(request, prefix);
              if (step === undefined) {
                continue;
              }
              if (step.includes("Close any popup")) {
                answers[`${prefix}done`] = noul(0.95);
                answers[`${prefix}operation`] = choice("BLOCKED");
                continue;
              }
              if (step.includes('"Shop"')) {
                answers[`${prefix}done`] = noul(0.1);
                answers[`${prefix}operation`] = choice("CLICK");
                answers[`${prefix}click_target`] = choice(
                  indexOf(request, "link", "Shop")
                );
                continue;
              }
              const adding = step.includes("Add Trail Hammer");
              answers[`${prefix}done`] = noul(
                adding && pageShows(request, "Trail Hammer added to cart")
                  ? 0.97
                  : 0.1
              );
              answers[`${prefix}operation`] = choice("CLICK");
              answers[`${prefix}click_target`] = choice(
                adding
                  ? indexOf(request, "button", "Add Trail Hammer to cart")
                  : indexOf(request, "link", "Cart")
              );
            }
            return respond(answers);
          };
          const result = yield* pursue(started.id, "steps-both", {
            steps: [
              {
                doneWhen: "The status line says the hammer was added.",
                goal: 'Select "Add Trail Hammer to cart".',
              },
              {
                // The Shop page also says "your cart", so code reads a
                // phrase only the cart shows.
                doneWhen: 'The page shows "Change delivery location".',
                goal: "Select the Cart link in the store navigation.",
              },
            ],
          });
          expect(result.ending).toBe("done");
          expect(result.steps.map((step) => step.ending)).toEqual([
            "done",
            "done",
          ]);
          expect(result.actions.map((action) => action.step)).toEqual([1, 2]);
          // The answer that ended step 1 also chose step 2's first action, and
          // the quoted text ended step 2 without asking again.
          expect(systemOne.requests).toHaveLength(2);
          expect(result.steps[1]?.reason).toBe(
            "The Page shows what doneWhen describes."
          );
          // A dismissing step narrows its choices to close controls, so its
          // request does not choose the next step's first action.
          const asked = systemOne.requests.length;
          const dismissed = yield* pursue(started.id, "steps-dismiss", {
            steps: [
              {
                doneWhen: "No popup covers the page.",
                goal: "Close any popup that covers the page.",
              },
              {
                doneWhen:
                  'The page shows "Tools for the trail and the workshop".',
                goal: 'Select "Shop" in the store navigation.',
              },
            ],
          });
          expect(dismissed.steps.map((step) => step.ending)).toEqual([
            "done",
            "done",
          ]);
          const [narrowed, following] = systemOne.requests.slice(asked);
          expect(Object.keys(narrowed?.questions ?? {})).not.toContain(
            "next_operation"
          );
          expect(following?.questions["operation"]).toBeDefined();
          expect(dismissed.actions.map((action) => action.step)).toEqual([2]);

          // Each step of the one call is its own record on the Run.
          const summary = yield* runTool("agent_run_complete", {
            operationId: operation("steps-complete"),
            sessionId: started.id,
          });
          if (!("schemaVersion" in summary) || summary.schemaVersion !== 3) {
            return yield* Effect.die("Expected a task Run Summary.");
          }
          expect(
            summary.pursuits?.map((pursuit) => [pursuit.step, pursuit.ending])
          ).toEqual([
            [1, "done"],
            [2, "done"],
            [1, "done"],
            [2, "done"],
          ]);
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

/** Click the named product's Add to cart until the Page says it was added. */
const addProduct =
  (product: string): Answer =>
  (request) =>
    respond({
      click_target: choice(
        indexOf(request, "button", `Add ${product} to cart`)
      ),
      done: noul(pageShows(request, `${product} added to cart`) ? 0.97 : 0.1),
      operation: choice("CLICK"),
    });

/** Act once, then leave the next request unanswered. */
const actThenHang = (first: Answer): Answer => {
  let asked = 0;
  return (request) => {
    asked += 1;
    return asked === 1 ? first(request) : "hang";
  };
};

it.live(
  "pursues afresh when a call with the same operation id was interrupted",
  () =>
    Effect.gen(function* retryInterruptedPursuits() {
      const files = yield* FileSystem.FileSystem;
      const root = yield* files.makeTempDirectoryScoped({
        prefix: "contingency-pursuit-retry-",
      });
      const systemOne = scripted();
      yield* Effect.scoped(
        Effect.gen(function* exerciseRetries() {
          const started = yield* exampleTool("agent_example_run_start", {
            example: FlowSkillName.make("example-delivery-cart"),
            inputs: [
              { name: "product", value: "Trail Hammer" },
              { name: "city", value: "Denver" },
              { name: "area", value: "Highlands" },
            ],
            operationId: operation("retry-start"),
          });
          const sessionId = started.id;
          const options = {
            doneWhen: "The status line reads that a product was added.",
            goal: "Add a product to the cart.",
          };

          // The first call acts once, then times out waiting on System One.
          systemOne.state.answer = actThenHang(addProduct("Trail Hammer"));
          const timedOut = yield* pursue(sessionId, "retry-cut", options).pipe(
            Effect.timeoutOption("3 seconds")
          );
          expect(Option.isNone(timedOut)).toBe(true);

          // The retry answers, and a different action under it takes an id
          // the interrupted call never used.
          systemOne.state.answer = addProduct("Cedar Pull Saw");
          const retried = yield* pursue(sessionId, "retry-cut", options);
          expect(retried.ending).toBe("done");
          expect(retried.actions.map((action) => action.operationId)).toEqual([
            "retry-cut/2",
          ]);
          expect(retried.actions[0]?.entry.dispatched).toBe(true);
          expect(retried.snapshot?.text).toContain(
            "Cedar Pull Saw added to cart"
          );

          // A call waiting on an interrupted one becomes its retry.
          systemOne.state.hung = Deferred.makeUnsafe<Questions>();
          systemOne.state.answer = actThenHang(addProduct("Brass Hinge Set"));
          const cut = yield* Effect.forkChild(
            pursue(sessionId, "retry-wait", options)
          );
          yield* Deferred.await(systemOne.state.hung);
          const waiting = yield* Effect.forkChild(
            pursue(sessionId, "retry-wait", options)
          );
          yield* Effect.sleep("200 millis");
          systemOne.state.answer = addProduct("Garden Trowel");
          yield* Fiber.interrupt(cut);
          const waited = yield* Fiber.join(waiting);
          expect(waited.ending).toBe("done");
          expect(waited.actions.map((action) => action.operationId)).toEqual([
            "retry-wait/2",
          ]);
          const asked = systemOne.requests.length;

          // A finished retry replays like any other call.
          const replayed = yield* pursue(sessionId, "retry-wait", options);
          expect(replayed.actions.map((action) => action.entry.id)).toEqual(
            waited.actions.map((action) => action.entry.id)
          );
          expect(systemOne.requests).toHaveLength(asked);
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
