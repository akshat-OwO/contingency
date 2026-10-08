import {
  AgentBrowserPursue,
  AgentActionSnapshotFormat,
  OperationId,
  optionalNullable,
  PURSUIT_LIMITS,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentBrowserSnapshot,
  AgentPursuitConfidence,
  AgentPursuitEnding,
  AgentPursuitResult,
  AgentSessionSnapshot,
  FlowSkillName,
  TaskAgentRunState,
} from "@contingency/protocol";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  Layer,
  Result,
  Schema,
} from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";
import {
  AgentSessionFailure,
  failure,
  snapshotBaselines,
} from "./mcp-agent-session.ts";
import {
  encodeUnpublishedPursuitResult,
  UnpublishedPursuitResult,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { isTaskRun } from "./run-lifecycle.ts";
import {
  actionSpace,
  buildRequest,
  targetKey,
  valueKey,
} from "./system-one-request.ts";
import type {
  ActionSpace,
  Candidate,
  ChoiceAnswer,
  Operation,
  SystemOneResponse,
} from "./system-one-request.ts";
import { SystemOne } from "./system-one.ts";
import type { SystemOneError } from "./system-one.ts";

/**
 * Delegated sub-goals ([ADR 0057](../../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 *
 * A small System One model chooses each next action from the current Browser
 * Snapshot, and every action goes through `AgentSession.act`, so Domain Scope,
 * the Execution Boundary, Confirmation, and interception apply exactly as they
 * do to the agent's own actions. The thresholds are fixed and assume a
 * calibrated endpoint; System One's confidence never authorizes anything.
 */
export const PURSUIT_THRESHOLDS = {
  doneAfterAction: 0.5,
  /** A literal `Done when:` can hold before the work is done. */
  doneBeforeAction: 0.9,
  /** The chosen answer must beat every alternative combined. */
  floor: 0.5,
} as const;

/** How many finished Pursuits the process keeps for replay. */
const REPLAY_LIMIT = 256;

/** Effects that end a Pursuit as `unsure` when seen this many times running. */
const NO_EFFECT_LIMIT = 2;

/**
 * How many times in a row System One may choose the same action. Some pages
 * need a second identical click; a third is a loop that only spends budget.
 */
const REPEAT_LIMIT = 2;

/** Browser failure reasons that say System One's choice did not hold. */
const UNSURE_FAILURES = new Set([
  "detached",
  "length_mismatch",
  "timeout",
  "value_mismatch",
]);

const AgentBrowserPursueParameters = Schema.Struct({
  ...AgentBrowserPursue.fields,
  format: optionalNullable(AgentActionSnapshotFormat),
});
type PursueParameters = typeof AgentBrowserPursueParameters.Type;

const AgentBrowserPursueTool = Tool.make("agent_browser_pursue", {
  dependencies: [AgentSession, SystemOne],
  description: `Delegate one Run or Dry Run sub-goal to the configured System One model. It acts until done, at most ${PURSUIT_LIMITS.maxActions} actions in ${PURSUIT_LIMITS.timeoutMs / 1000} s; maxActions and timeoutMs only lower these. goal is one Flow Skill step; doneWhen is what the Page visibly shows once it holds. Actions get agent_browser_act checks; irreversible:true confirms each. Endings: done, blocked (no way forward or intercepted), unsure (low confidence, no effect twice, a third identical action, a failed action, or spent budget), paused (Execution Boundary or Takeover), needs-input (request missingVariable, then pursue again). Actions remain whatever the ending; verify done in the Snapshot before assessing. System One receives Page text, elements, recent actions, and ordinary input values; private Variables only by name. Same operationId replays.`,
  failure: AgentSessionFailure,
  parameters: AgentBrowserPursueParameters,
  success: UnpublishedPursuitResult,
});

export const PursuitTools = withStrictParameters(
  Toolkit.make(AgentBrowserPursueTool)
);

/** One value System One may choose for a field. */
type ScopeInput =
  | {
      readonly flowSkillName: FlowSkillName;
      readonly kind: "value";
      readonly name: string;
      readonly value: string;
    }
  | {
      readonly flowSkillName: FlowSkillName;
      readonly kind: "variable";
      readonly name: string;
      readonly supplied: boolean;
    };

/**
 * The inputs a Pursuit may put into fields, keyed by the name System One
 * answers with. Ordinary values travel; a Variable travels by name only, and
 * Contingency substitutes the value when it acts.
 */
const inputsInScope = (
  run: TaskAgentRunState,
  flowSkillName: FlowSkillName | undefined
) => {
  const inScope = (owner: FlowSkillName) =>
    flowSkillName === undefined || owner === flowSkillName;
  const entries: ScopeInput[] = [];
  for (const input of run.inputs) {
    if (inScope(input.flowSkillName)) {
      entries.push({ ...input, kind: "value" });
    }
  }
  for (const variable of run.variables) {
    if (inScope(variable.flowSkillName)) {
      entries.push({
        flowSkillName: variable.flowSkillName,
        kind: "variable",
        name: variable.name,
        supplied: variable.supplied,
      });
    }
  }
  // Two skills may declare the same name; their keys must still differ.
  const counts = new Map<string, number>();
  for (const { name } of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const inputs = new Map<string, ScopeInput>();
  const criteria: Record<string, string> = {};
  for (const input of entries) {
    const key =
      (counts.get(input.name) ?? 0) > 1
        ? `${input.flowSkillName}/${input.name}`
        : input.name;
    if (!inputs.has(key)) {
      inputs.set(key, input);
      criteria[key] =
        input.kind === "value"
          ? input.value
          : `the private Variable ${input.name}`;
    }
  }
  return { criteria, inputs };
};

const choiceOf = (
  response: SystemOneResponse,
  key: string
): ChoiceAnswer | undefined => {
  const answer = response.answers[key];
  return answer?.type === "choice" ? answer : undefined;
};

/**
 * The probability System One gives its chosen answer. Endpoints also report a
 * `confidence` that rescales it against an even split; the floor is about the
 * answer itself beating every alternative combined, so it reads this.
 */
const probabilityOf = (answer: ChoiceAnswer | undefined): number =>
  answer === undefined ? 0 : (answer.probabilities[answer.choice] ?? 0);

const noulOf = (response: SystemOneResponse, key: string): number => {
  const answer = response.answers[key];
  return answer?.type === "noul" ? answer.noul : 0;
};

const isOperation = (choice: string | undefined): choice is Operation =>
  choice === "CLICK" || choice === "FILL" || choice === "SELECT";

type Ending = Pick<AgentPursuitResult, "ending" | "reason"> &
  Partial<Pick<AgentPursuitResult, "intervention" | "missingVariable">>;

const end = (
  ending: AgentPursuitEnding,
  reason: string,
  extra: Partial<
    Pick<AgentPursuitResult, "intervention" | "missingVariable">
  > = {}
): Ending => ({ ending, reason, ...extra });

const confidenceText = (value: number) => value.toFixed(2);

/** Why the agent cannot act on this session right now, if it cannot. */
const pauseOf = (session: AgentSessionSnapshot): Ending | undefined => {
  if (session.boundary !== undefined && session.boundary !== null) {
    return end(
      "paused",
      "An Execution Boundary waits for the user's decision.",
      { intervention: session.boundary }
    );
  }
  if (session.controller !== "agent" || session.phase === "takeover") {
    return end("paused", "The user holds the browser.");
  }
  return undefined;
};

/** The next action one System One answer chose, or how the Pursuit ends. */
type Decision =
  | { readonly ending: Ending; readonly kind: "end" }
  | {
      readonly candidate: Candidate;
      readonly confidence: AgentPursuitConfidence;
      readonly input: ScopeInput | undefined;
      readonly kind: "act";
    };

const stop = (ending: Ending): Decision => ({ ending, kind: "end" });

/** The operation and element System One chose, held to the floor. */
const decideTarget = (response: SystemOneResponse, space: ActionSpace) => {
  const operation = choiceOf(response, "operation");
  if (operation?.choice === "BLOCKED") {
    return end(
      "blocked",
      `System One found no element that makes progress (${confidenceText(probabilityOf(operation))}).`
    );
  }
  if (
    operation === undefined ||
    !isOperation(operation.choice) ||
    probabilityOf(operation) < PURSUIT_THRESHOLDS.floor
  ) {
    return end(
      "unsure",
      `System One was unsure of the next operation (${operation?.choice ?? "none"}, ${confidenceText(probabilityOf(operation))}).`
    );
  }
  const kind = operation.choice;
  const target = choiceOf(response, targetKey(kind));
  const candidate =
    target === undefined
      ? undefined
      : space.targets.get(kind)?.get(target.choice);
  if (
    target === undefined ||
    candidate === undefined ||
    probabilityOf(target) < PURSUIT_THRESHOLDS.floor
  ) {
    return end(
      "unsure",
      `System One was unsure which element to ${kind.toLowerCase()} (${confidenceText(probabilityOf(target))}).`
    );
  }
  return { candidate, kind, operation, target };
};

/** The input System One chose for a field, held to the floor. */
const decideValue = (
  response: SystemOneResponse,
  index: string,
  candidate: Candidate,
  inputs: ReadonlyMap<string, ScopeInput>
) => {
  const value = choiceOf(response, valueKey(index));
  const input = value === undefined ? undefined : inputs.get(value.choice);
  if (
    value === undefined ||
    input === undefined ||
    probabilityOf(value) < PURSUIT_THRESHOLDS.floor
  ) {
    return end(
      "unsure",
      `System One was unsure which input to put in ${candidate.describe} (${confidenceText(probabilityOf(value))}).`
    );
  }
  return { confidence: probabilityOf(value), input };
};

/** Read one System One answer against the Pursuit's stop conditions. */
const decide = (
  response: SystemOneResponse,
  space: ActionSpace,
  inputs: ReadonlyMap<string, ScopeInput>,
  budget: { readonly acted: number; readonly maxActions: number }
): Decision => {
  const done = noulOf(response, "done");
  const doneThreshold =
    budget.acted === 0
      ? PURSUIT_THRESHOLDS.doneBeforeAction
      : PURSUIT_THRESHOLDS.doneAfterAction;
  if (done >= doneThreshold) {
    return stop(
      end(
        "done",
        `System One judged the Page to satisfy doneWhen (${confidenceText(done)}).`
      )
    );
  }
  if (budget.acted >= budget.maxActions) {
    return stop(
      end(
        "unsure",
        `The ${budget.maxActions}-action budget ran out before doneWhen held (${confidenceText(done)}).`
      )
    );
  }
  const chosen = decideTarget(response, space);
  if ("ending" in chosen) {
    return stop(chosen);
  }
  const { candidate, kind, operation, target } = chosen;
  if (kind === "CLICK") {
    return {
      candidate,
      confidence: {
        operation: probabilityOf(operation),
        target: probabilityOf(target),
        value: null,
      },
      input: undefined,
      kind: "act",
    };
  }
  const value = decideValue(response, target.choice, candidate, inputs);
  if ("ending" in value) {
    return stop(value);
  }
  const { input } = value;
  if (input.kind === "variable" && !input.supplied) {
    return stop(
      end(
        "needs-input",
        `System One chose Variable ${input.name}, which has no value yet. Request it with agent_variable_request, then pursue again.`,
        {
          missingVariable: {
            flowSkillName: input.flowSkillName,
            name: input.name,
          },
        }
      )
    );
  }
  if (input.kind === "variable" && kind === "SELECT") {
    return stop(
      end(
        "unsure",
        `System One chose private Variable ${input.name} for a list, which a Pursuit cannot select.`
      )
    );
  }
  return {
    candidate,
    confidence: {
      operation: probabilityOf(operation),
      target: probabilityOf(target),
      value: value.confidence,
    },
    input,
    kind: "act",
  };
};

/** How a performed action ends the Pursuit, if it does. */
const actionEnding = (
  result: AgentActionResult,
  noEffect: number
): Ending | undefined => {
  if (result.intervention !== undefined) {
    return end(
      "paused",
      `The action waits at an Execution Boundary (${result.intervention.reason}). Resume it with agent_browser_resume once the user decides.`,
      { intervention: result.intervention }
    );
  }
  if (result.entry.outcome !== "completed") {
    return end(
      "unsure",
      `The action was ${result.entry.outcome}: ${result.entry.detail ?? result.entry.description}`
    );
  }
  if (noEffect >= NO_EFFECT_LIMIT) {
    return end(
      "unsure",
      `${NO_EFFECT_LIMIT} actions in a row had no visible effect.`
    );
  }
  return undefined;
};

/** How a refused or failed action ends the Pursuit. */
const failureEnding = (cause: AgentSessionError): Ending => {
  const reason = cause._tag === "BrowserRpcError" ? cause.reason : undefined;
  if (reason === "intercepted") {
    return end("blocked", cause.message);
  }
  if (cause.code === "agent_control_unavailable") {
    return end("paused", cause.message);
  }
  return end(
    "unsure",
    reason !== undefined && UNSURE_FAILURES.has(reason)
      ? `The chosen action failed (${reason}): ${cause.message}`
      : `The chosen action failed: ${cause.message}`
  );
};

/** System One itself failed, the one failure that fails the call. */
const systemOneFailure = (
  cause: SystemOneError,
  taken: readonly string[]
): AgentSessionFailure =>
  new AgentSessionFailure({
    code: "system_one_failed",
    message: `${cause.message} ${
      taken.length === 0
        ? "No action was taken."
        : `These actions were taken and remain: ${taken.join("; ")}. Read the Page before continuing.`
    } (system_one_failed)`,
  });

/** What a Pursuit has done so far. */
interface PursuitProgress {
  readonly actions: AgentPursuitResult["actions"][number][];
  latest: { snapshot: AgentBrowserSnapshot; url: string } | null;
  noEffect: number;
  readonly recent: string[];
  /** The last chosen action, and how many times in a row it was chosen. */
  repeat: { key: string; times: number } | null;
}

/** The Run a Pursuit belongs to, refusing Teaching and ordered Runs. */
const requireTaskRun = (session: AgentSessionSnapshot) => {
  if (session.activity !== "run") {
    return Effect.fail(
      new AgentSessionFailure({
        code: "agent_session_invalid",
        message:
          "Pursuits run only in Interactive Runs and Dry Runs, never during Teaching. (agent_session_invalid)",
      })
    );
  }
  const { run } = session;
  if (run === null || !isTaskRun(run)) {
    return Effect.fail(
      new AgentSessionFailure({
        code: "agent_session_invalid",
        message:
          "Pursuits need a task Run started with agent_run_start or a Dry Run. (agent_session_invalid)",
      })
    );
  }
  return Effect.succeed(run);
};

/** Perform one sub-goal until one of its stop conditions holds. */
const pursue = (params: PursueParameters) =>
  Effect.gen(function* runPursuit() {
    const service = yield* AgentSession;
    const systemOne = yield* SystemOne;
    const { sessionId } = params;
    const run = yield* requireTaskRun(yield* service.get(sessionId));
    const { criteria, inputs } = inputsInScope(run, params.flowSkillName);
    const withheld = [...inputs.values()].some(
      (input) => input.kind === "variable"
    );
    const maxActions = Math.min(
      params.maxActions ?? PURSUIT_LIMITS.maxActions,
      PURSUIT_LIMITS.maxActions
    );
    const timeoutMs = Math.min(
      params.timeoutMs ?? PURSUIT_LIMITS.timeoutMs,
      PURSUIT_LIMITS.timeoutMs
    );
    const startedAt = yield* Clock.currentTimeMillis;
    const timeEnding = Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        now - startedAt >= timeoutMs
          ? end("unsure", `The ${timeoutMs / 1000}-second budget ran out.`)
          : undefined
      )
    );
    const progress: PursuitProgress = {
      actions: [],
      latest: null,
      noEffect: 0,
      recent: [],
      repeat: null,
    };

    /** Act as the agent's own action would, or enter a Variable by name. */
    const perform = (
      decision: Extract<Decision, { kind: "act" }>,
      operationId: OperationId
    ) =>
      Effect.gen(function* performChosenAction() {
        const { candidate, input } = decision;
        // A private input carries no intent, so it cannot be confirmed here.
        if (input?.kind === "variable" && params.irreversible === true) {
          return end(
            "unsure",
            `System One chose private Variable ${input.name}; enter it with agent_variable_enter.`
          );
        }
        const attempt = yield* Effect.result(
          input?.kind === "variable"
            ? service.enterSuppliedVariable(
                sessionId,
                input.name,
                candidate.ref,
                operationId,
                input.flowSkillName
              )
            : service.act(
                sessionId,
                candidate.action(input?.value ?? ""),
                operationId,
                params.irreversible === true
                  ? { irreversible: true }
                  : undefined
              )
        );
        if (Result.isFailure(attempt)) {
          return failureEnding(attempt.failure);
        }
        const result = attempt.success;
        progress.latest = { snapshot: result.snapshot, url: result.url };
        progress.actions.push({
          confidence: decision.confidence,
          entry: result.entry,
          operationId,
          variable: input?.kind === "variable" ? input.name : null,
        });
        progress.recent.push(result.entry.description);
        progress.noEffect =
          result.entry.effect?.kind === "none" ? progress.noEffect + 1 : 0;
        return actionEnding(result, progress.noEffect);
      });

    const step = Effect.gen(function* decideAndAct() {
      const paused = pauseOf(yield* service.get(sessionId));
      if (paused !== undefined) {
        return paused;
      }
      const late = yield* timeEnding;
      if (late !== undefined) {
        return late;
      }
      const snapshot = yield* service.snapshot(sessionId);
      progress.latest = { snapshot, url: snapshot.url };
      const space = actionSpace(snapshot, { withheld });
      const { questions, state } = buildRequest(
        "",
        {
          current: {
            doneWhen: params.doneWhen,
            inputs: criteria,
            instruction: params.goal,
            step: 1,
          },
          next: undefined,
        },
        space,
        snapshot,
        progress.recent
      );
      const response = yield* systemOne
        .ask({ questions, state })
        .pipe(
          Effect.mapError((cause) => systemOneFailure(cause, progress.recent))
        );
      const decision = decide(response, space, inputs, {
        acted: progress.actions.length,
        maxActions,
      });
      if (decision.kind === "end") {
        return decision.ending;
      }
      // No new action starts once the time budget is spent.
      const spent = yield* timeEnding;
      if (spent !== undefined) {
        return spent;
      }
      // References change across reads, so an action is known by its
      // element's role and name and the input it enters.
      const key = JSON.stringify([
        decision.candidate.describe.replace(/^\[\d+\] /u, ""),
        decision.input?.name ?? null,
      ]);
      const times =
        progress.repeat?.key === key ? progress.repeat.times + 1 : 1;
      if (times > REPEAT_LIMIT) {
        return end(
          "unsure",
          `System One chose ${decision.candidate.describe.replace(/^\[\d+\] /u, "")} a third time in a row without doneWhen holding.`
        );
      }
      progress.repeat = { key, times };
      return yield* perform(
        decision,
        OperationId.make(`${params.operationId}/${progress.actions.length + 1}`)
      );
    });

    let ending: Ending | undefined;
    while (ending === undefined) {
      ending = yield* step;
    }
    const finished: AgentPursuitResult = {
      actions: progress.actions,
      ending: ending.ending,
      intervention: ending.intervention ?? null,
      missingVariable: ending.missingVariable ?? null,
      reason: ending.reason,
      snapshot: progress.latest?.snapshot ?? null,
      url: progress.latest?.url ?? null,
    };
    yield* service
      .recordPursuit(sessionId, {
        actions: progress.actions.map((action) => ({
          attemptId: action.entry.id,
          confidence: action.confidence,
        })),
        doneWhen: params.doneWhen,
        endedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        ending: finished.ending,
        goal: params.goal,
        operationId: params.operationId,
        reason: finished.reason,
      })
      // A Run that ended mid-Pursuit keeps the attempts on its timeline.
      .pipe(Effect.ignore);
    return finished;
  });

interface Replay {
  readonly done: Deferred.Deferred<AgentPursuitResult, AgentSessionFailure>;
  readonly request: string;
}

export const PursuitToolHandlersLive = PursuitTools.toLayer(
  Effect.sync(() => {
    const replays = new Map<string, Replay>();
    return {
      agent_browser_pursue: (params) =>
        Effect.gen(function* pursueSubGoal() {
          const service = yield* AgentSession;
          yield* service.noteAgentActivity(params.sessionId);
          const key = `${params.sessionId}\u0000${params.operationId}`;
          const { format, ...request } = params;
          const fingerprint = JSON.stringify(request);
          const existing = replays.get(key);
          let finished: AgentPursuitResult;
          if (existing === undefined) {
            const done = yield* Deferred.make<
              AgentPursuitResult,
              AgentSessionFailure
            >();
            replays.set(key, { done, request: fingerprint });
            while (replays.size > REPLAY_LIMIT) {
              const oldest = replays.keys().next().value;
              if (oldest === undefined) {
                break;
              }
              replays.delete(oldest);
            }
            const exit = yield* Effect.exit(
              pursue(params).pipe(
                Effect.mapError((cause) =>
                  cause instanceof AgentSessionFailure ? cause : failure(cause)
                )
              )
            );
            // An interrupted call never finished; a retry pursues afresh and
            // its derived action ids replay the attempts already made.
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
              replays.delete(key);
            }
            yield* Deferred.done(done, exit);
            finished = yield* exit;
          } else if (existing.request === fingerprint) {
            finished = yield* Deferred.await(existing.done);
          } else {
            return yield* new AgentSessionFailure({
              code: "agent_session_conflict",
              message:
                "This operation id already pursued a different sub-goal. Use a new operation id. (agent_session_conflict)",
            });
          }
          return yield* encodeUnpublishedPursuitResult({
            ...finished,
            snapshot:
              finished.snapshot === null
                ? null
                : snapshotBaselines.present(
                    params.sessionId,
                    finished.snapshot,
                    format ?? "text"
                  ),
          });
        }),
    };
  })
);

/** Present only when the machine names a System One endpoint. */
export const McpPursuitLayer = McpServer.toolkit(PursuitTools).pipe(
  Layer.provide(PursuitToolHandlersLive)
);
