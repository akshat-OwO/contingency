import {
  AgentBrowserPursue,
  AgentActionSnapshotFormat,
  OperationId,
  optionalNullable,
  PURSUIT_LIMITS,
} from "@contingency/protocol";
import type {
  AgentActionResult,
  AgentActionSignal,
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
  isCovered,
  NEXT,
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
  description: `Delegate Run or Dry Run steps to the configured System One model. steps: ordered {goal, doneWhen}; goal is one Flow Skill step, doneWhen what the Page shows once it holds. Double-quoted text in doneWhen must appear verbatim. Returns at the first step not done. Per step ${PURSUIT_LIMITS.maxActions} actions, per call ${PURSUIT_LIMITS.timeoutMs / 1000} s; maxActions and timeoutMs only lower these. Actions get agent_browser_act checks; irreversible:true confirms each. Endings: done, blocked, unsure, paused (boundary or Takeover), needs-input (request missingVariable, pursue again); reason says why. Actions remain; verify done in the Snapshot. System One gets Page text, elements, recent actions, and ordinary input values; private Variables by name only. Same operationId replays.`,
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
const decideTarget = (
  response: SystemOneResponse,
  prefix: string,
  space: ActionSpace
) => {
  const operation = choiceOf(response, `${prefix}operation`);
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
  const target = choiceOf(response, `${prefix}${targetKey(kind)}`);
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
  prefix: string,
  index: string,
  candidate: Candidate,
  inputs: ReadonlyMap<string, ScopeInput>
) => {
  const value = choiceOf(response, `${prefix}${valueKey(index)}`);
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

/** Wording under which quoted text describes what must be absent. */
const NEGATED =
  /\b(?:gone|no|not|never|disappears?|disappeared|removed|hidden|without|absent|closes|closed)\b/iu;
const QUOTED = /"(?<straight>[^"]+)"|\u201C(?<curly>[^\u201D]+)\u201D/gu;

/** Whether `doneWhen`, outside its quotes, describes something going away. */
const describesAbsence = (doneWhen: string) =>
  NEGATED.test(doneWhen.replaceAll(QUOTED, " "));

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .replace(/[.!]+$/u, "")
    .trim();

/** The phrases `doneWhen` quotes, or `undefined` when none count. */
const quotedPhrases = (doneWhen: string): readonly string[] | undefined => {
  const phrases: string[] = [];
  for (const match of doneWhen.matchAll(QUOTED)) {
    const phrase = normalized(
      match.groups?.["straight"] ?? match.groups?.["curly"] ?? ""
    );
    if (phrase.length > 0) {
      phrases.push(phrase);
    }
  }
  return phrases.length === 0 ? undefined : phrases;
};

/** The Page's text; what another element covers is not on show. */
const shownText = (snapshot: AgentBrowserSnapshot, covered: boolean) => {
  const parts: string[] = [];
  for (const node of snapshot.nodes) {
    if (covered || !isCovered(node)) {
      parts.push(`${node.name} ${node.value ?? ""}`);
    }
  }
  return normalized(parts.join(" "));
};

const WORD = /[\p{L}\p{N}_]/u;

/** Whether two adjacent characters belong to one word. */
const joins = (left: string | undefined, right: string | undefined) =>
  left !== undefined &&
  right !== undefined &&
  WORD.test(left) &&
  WORD.test(right);

/**
 * Whether normalized Page text contains a normalized phrase as whole words,
 * so `1 item` is not read in `11 items`.
 */
const shows = (text: string, phrase: string) => {
  let at = text.indexOf(phrase);
  while (at !== -1) {
    const after = text[at + phrase.length];
    if (!joins(text[at - 1], phrase[0]) && !joins(phrase.at(-1), after)) {
      return true;
    }
    at = text.indexOf(phrase, at + 1);
  }
  return false;
};

/**
 * Whether each quoted phrase holds on the Page: shown, or no longer shown
 * when `doneWhen` describes it going away.
 */
const phrasesHold = (
  doneWhen: string,
  phrases: readonly string[],
  snapshot: AgentBrowserSnapshot
) => {
  const shown = shownText(snapshot, false);
  // `The "Demo fault" banner is gone` holds once its text is no longer shown.
  const absence = describesAbsence(doneWhen);
  return phrases.map((phrase) => shows(shown, phrase) !== absence);
};

/**
 * What the phrases `doneWhen` quotes say about the step. A quoted phrase is
 * the outcome's literal text, so code reads it more reliably than a model
 * does. `false` when one does not hold. `true` when all hold and, given the
 * Page the step started on, none held there. `undefined` when `doneWhen`
 * quotes nothing, or when a phrase held from the start: text that was
 * already there says nothing about what the step did.
 */
export const quotedOutcome = (
  doneWhen: string,
  snapshot: AgentBrowserSnapshot,
  start?: AgentBrowserSnapshot
): boolean | undefined => {
  const phrases = quotedPhrases(doneWhen);
  if (phrases === undefined) {
    return undefined;
  }
  if (!phrasesHold(doneWhen, phrases, snapshot).every(Boolean)) {
    return false;
  }
  if (
    start !== undefined &&
    phrasesHold(doneWhen, phrases, start).some(Boolean)
  ) {
    return undefined;
  }
  return true;
};

/**
 * Whether the quoted outcome is in the document but something covers it,
 * such as an advertisement shown once a step's work is done.
 */
export const coveredOutcome = (
  doneWhen: string,
  snapshot: AgentBrowserSnapshot
): boolean => {
  const phrases = quotedPhrases(doneWhen);
  if (phrases === undefined || describesAbsence(doneWhen)) {
    return false;
  }
  const shown = shownText(snapshot, false);
  const present = shownText(snapshot, true);
  return (
    phrases.every((phrase) => shows(present, phrase)) &&
    !phrases.every((phrase) => shows(shown, phrase))
  );
};

/** Controls that dismiss a popup, by their accessible name. */
const DISMISS =
  /\b(?:close|dismiss|cancel|not now|no thanks|maybe later|got it)\b|[\u00D7\u2715\u2716]/iu;

/**
 * The action space narrowed to dismissing controls, or unchanged when the
 * Page names none. System One still chooses which one.
 */
const dismissSpace = (space: ActionSpace): ActionSpace => {
  const clicks = space.targets.get("CLICK");
  const dismissing = new Map(
    [...(clicks ?? new Map<string, Candidate>())].filter(([, candidate]) =>
      DISMISS.test(candidate.describe)
    )
  );
  return dismissing.size === 0
    ? space
    : { ...space, targets: new Map([["CLICK", dismissing]]) };
};

/** Wording that names something laid over the Page. */
const OVERLAY =
  /\b(?:popups?|pop-ups?|overlays?|dialogs?|modals?|advertisements?|ads?|sheets?)\b/iu;

/**
 * Whether nothing covers the Page, for a `doneWhen` that asks for a popup
 * or overlay to be gone; `undefined` for any other outcome. One picture laid
 * over another is page design, not a popup.
 */
export const overlayOutcome = (
  doneWhen: string,
  snapshot: AgentBrowserSnapshot
): boolean | undefined =>
  describesAbsence(doneWhen) && OVERLAY.test(doneWhen)
    ? !snapshot.nodes.some(
        (node) => isCovered(node) && node.blockedBy?.role !== "img"
      )
    : undefined;

/**
 * What the Page shows about `doneWhen`, read in code where it can be, against
 * the Page the step started on.
 */
const codeOutcome = (
  doneWhen: string,
  snapshot: AgentBrowserSnapshot,
  start: AgentBrowserSnapshot
) =>
  quotedPhrases(doneWhen) === undefined
    ? overlayOutcome(doneWhen, snapshot)
    : quotedOutcome(doneWhen, snapshot, start);

/** What System One is asked to do while a popup covers the outcome. */
const UNCOVER_INSTRUCTION =
  "Close the popup, dialog, or advertisement that covers the page, using its own close control.";

/** Whether the step holds, from System One's answer and any quoted text. */
const doneEnding = (
  done: number,
  acted: number,
  quoted: boolean | undefined
): Ending | undefined => {
  if (quoted === false) {
    return undefined;
  }
  // Before any action, quoted text can already be on the Page (a search
  // box shown before its city is chosen), so it vetoes but never confirms.
  if (quoted === true && acted > 0) {
    return end("done", "The Page shows what doneWhen describes.");
  }
  const threshold =
    acted === 0
      ? PURSUIT_THRESHOLDS.doneBeforeAction
      : PURSUIT_THRESHOLDS.doneAfterAction;
  return done >= threshold
    ? end(
        "done",
        `System One judged the Page to satisfy doneWhen (${confidenceText(done)}).`
      )
    : undefined;
};

/** Read one System One answer against the Pursuit's stop conditions. */
const decide = (
  response: SystemOneResponse,
  prefix: string,
  space: ActionSpace,
  inputs: ReadonlyMap<string, ScopeInput>,
  budget: {
    readonly acted: number;
    readonly maxActions: number;
    readonly quoted: boolean | undefined;
  }
): Decision => {
  const done = noulOf(response, `${prefix}done`);
  const held = doneEnding(done, budget.acted, budget.quoted);
  if (held !== undefined) {
    return stop(held);
  }
  if (budget.acted >= budget.maxActions) {
    return stop(
      end(
        "unsure",
        `The ${budget.maxActions}-action budget ran out before doneWhen held (${confidenceText(done)}).`
      )
    );
  }
  const chosen = decideTarget(response, prefix, space);
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
  const value = decideValue(response, prefix, target.choice, candidate, inputs);
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

/**
 * Whether an action failed because the Page moved on under the decision: its
 * element left the document or has no reachable point left. Reading the Page
 * again can recover, which a covered or refused target cannot.
 */
const isStaleTarget = (cause: AgentSessionError): boolean =>
  cause._tag === "BrowserRpcError" &&
  (cause.reason === "detached" ||
    cause.message.includes("no reachable point in the viewport"));

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

/**
 * The Snapshot an action answered with, when the next decision may read it
 * instead of the Page. A Page still settling, or a new document that may
 * still be redirecting, is read again.
 */
const reusableSnapshot = (
  result: AgentActionResult
): AgentBrowserSnapshot | null => {
  const signals: readonly AgentActionSignal[] =
    result.entry.effect?.kind === "observed" ? result.entry.effect.signals : [];
  return result.snapshot.settle?.settled === false ||
    signals.includes("url") ||
    signals.includes("page")
    ? null
    : result.snapshot;
};

/** The action key repeats are counted by: element role and name, and input. */
const actionKey = (decision: Extract<Decision, { kind: "act" }>) => {
  const subject = decision.candidate.describe.replace(/^\[\d+\] /u, "");
  return {
    key: JSON.stringify([subject, decision.input?.name ?? null]),
    subject,
  };
};

/** What a Pursuit has done so far. */
interface PursuitProgress {
  readonly actions: AgentPursuitResult["actions"][number][];
  /** Attempts so far, failed ones included, which number operation ids. */
  attempts: number;
  latest: { snapshot: AgentBrowserSnapshot; url: string } | null;
  /**
   * The settled Snapshot the last action answered with. The next decision
   * reads it instead of the Page, which saves a read per action.
   */
  fresh: AgentBrowserSnapshot | null;
  noEffect: number;
  readonly recent: string[];
  /** Whether this step already read the Page again after a stale target. */
  reread: boolean;
  /** The Page this step started on, which quoted outcomes are read against. */
  start: AgentBrowserSnapshot | null;
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

/**
 * The answers a step's last request gave about the step after it, on the
 * Page that step ended on. The next step decides from them without asking.
 */
interface Lookahead {
  readonly response: SystemOneResponse;
  readonly snapshot: AgentBrowserSnapshot;
  readonly space: ActionSpace;
}

/** Perform each sub-goal in order until one does not end `done`. */
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
    const cues = params.steps.map((step, index) => ({
      doneWhen: step.doneWhen,
      inputs: criteria,
      instruction: step.goal,
      step: index + 1,
    }));
    const progress: PursuitProgress = {
      actions: [],
      attempts: 0,
      fresh: null,
      latest: null,
      noEffect: 0,
      recent: [],
      repeat: null,
      reread: false,
      start: null,
    };
    let lookahead: Lookahead | null = null;

    /** The chosen action, or a Variable entered by name. */
    const dispatch = (
      { candidate, input }: Extract<Decision, { kind: "act" }>,
      operationId: OperationId
    ) =>
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
            params.irreversible === true ? { irreversible: true } : undefined
          );

    /** Act as the agent's own action would, or enter a Variable by name. */
    const perform = (
      decision: Extract<Decision, { kind: "act" }>,
      operationId: OperationId,
      step: number
    ) =>
      Effect.gen(function* performChosenAction() {
        const { input } = decision;
        // A private input carries no intent, so it cannot be confirmed here.
        if (input?.kind === "variable" && params.irreversible === true) {
          return end(
            "unsure",
            `System One chose private Variable ${input.name}; enter it with agent_variable_enter.`
          );
        }
        const attempt = yield* Effect.result(dispatch(decision, operationId));
        if (Result.isFailure(attempt)) {
          if (isStaleTarget(attempt.failure) && !progress.reread) {
            progress.reread = true;
            progress.fresh = null;
            return;
          }
          return failureEnding(attempt.failure);
        }
        const result = attempt.success;
        progress.latest = { snapshot: result.snapshot, url: result.url };
        progress.fresh = reusableSnapshot(result);
        progress.actions.push({
          confidence: decision.confidence,
          entry: result.entry,
          operationId,
          step,
          variable: input?.kind === "variable" ? input.name : null,
        });
        progress.recent.push(result.entry.description);
        progress.noEffect =
          result.entry.effect?.kind === "none" ? progress.noEffect + 1 : 0;
        return actionEnding(result, progress.noEffect);
      });

    /**
     * Read the Page and ask System One about the step at `index`, unless
     * code can already see the step holds.
     */
    const consult = (
      index: number,
      cue: (typeof cues)[number],
      acted: number
    ) =>
      Effect.gen(function* readAndAsk() {
        const snapshot = progress.fresh ?? (yield* service.snapshot(sessionId));
        progress.fresh = null;
        progress.latest = { snapshot, url: snapshot.url };
        // What code can read after an action settles the step without asking.
        if (
          acted > 0 &&
          codeOutcome(cue.doneWhen, snapshot, progress.start ?? snapshot) ===
            true
        ) {
          // The next step starts from this same read.
          progress.fresh = snapshot;
          return end("done", "The Page shows what doneWhen describes.");
        }
        // The step's outcome is there but covered: uncover it first.
        const covered = acted > 0 && coveredOutcome(cue.doneWhen, snapshot);
        const visible = actionSpace(snapshot, { visibleOnly: true, withheld });
        // A step that is itself about dismissing gets the same narrowing.
        const narrowed = covered || DISMISS.test(cue.instruction);
        const space = narrowed ? dismissSpace(visible) : visible;
        // The next step's first action needs the whole Page, so a narrowed
        // request does not ask about it.
        const next = narrowed ? undefined : cues[index + 1];
        const { questions, state } = buildRequest(
          "",
          {
            current: covered
              ? { ...cue, instruction: UNCOVER_INSTRUCTION }
              : cue,
            next,
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
        return { asksNext: next !== undefined, response, snapshot, space };
      });

    /** One decision for the step at `index`, and its action if it chose one. */
    const advance = (index: number, acted: number) =>
      Effect.gen(function* decideAndAct() {
        const cue = cues[index];
        if (cue === undefined) {
          return end("done", "No step remains.");
        }
        const paused = pauseOf(yield* service.get(sessionId));
        if (paused !== undefined) {
          return paused;
        }
        const late = yield* timeEnding;
        if (late !== undefined) {
          return late;
        }
        const carried = lookahead;
        lookahead = null;
        let response: SystemOneResponse;
        let prefix = "";
        let snapshot: AgentBrowserSnapshot;
        let space: ActionSpace;
        let asksNext = false;
        if (carried === null) {
          const consulted = yield* consult(index, cue, acted);
          if ("ending" in consulted) {
            return consulted;
          }
          ({ asksNext, response, snapshot, space } = consulted);
        } else {
          ({ response, snapshot, space } = carried);
          prefix = NEXT;
        }
        progress.start ??= snapshot;
        const decision = decide(response, prefix, space, inputs, {
          acted,
          maxActions,
          quoted: codeOutcome(cue.doneWhen, snapshot, progress.start),
        });
        if (decision.kind === "end") {
          // The same answer already says how the next step begins.
          if (decision.ending.ending === "done" && asksNext) {
            lookahead = { response, snapshot, space };
          }
          return decision.ending;
        }
        // No new action starts once the time budget is spent.
        const spent = yield* timeEnding;
        if (spent !== undefined) {
          return spent;
        }
        // References change across reads, so an action is known by its
        // element's role and name and the input it enters.
        const { key, subject } = actionKey(decision);
        const times =
          progress.repeat?.key === key ? progress.repeat.times + 1 : 1;
        if (times > REPEAT_LIMIT) {
          return end(
            "unsure",
            `System One chose ${subject} a third time in a row without doneWhen holding.`
          );
        }
        progress.repeat = { key, times };
        progress.attempts += 1;
        return yield* perform(
          decision,
          OperationId.make(`${params.operationId}/${progress.attempts}`),
          index + 1
        );
      });

    const steps: AgentPursuitResult["steps"][number][] = [];
    let ending: Ending = end("done", "No step was given.");
    for (const [index, cue] of cues.entries()) {
      const firstAction = progress.actions.length;
      progress.noEffect = 0;
      progress.repeat = null;
      progress.reread = false;
      progress.start = null;
      let stepEnding: Ending | undefined;
      while (stepEnding === undefined) {
        stepEnding = yield* advance(
          index,
          progress.actions.length - firstAction
        );
      }
      ending = stepEnding;
      steps.push({ ending: stepEnding.ending, reason: stepEnding.reason });
      const endedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* service
        .recordPursuit(sessionId, {
          actions: progress.actions.slice(firstAction).map((action) => ({
            attemptId: action.entry.id,
            confidence: action.confidence,
          })),
          doneWhen: cue.doneWhen,
          endedAt,
          ending: stepEnding.ending,
          goal: cue.instruction,
          operationId: params.operationId,
          reason: stepEnding.reason,
          step: index + 1,
        })
        // A Run that ended mid-Pursuit keeps the attempts on its timeline.
        .pipe(Effect.ignore);
      if (stepEnding.ending !== "done") {
        break;
      }
    }
    return {
      actions: progress.actions,
      ending: ending.ending,
      intervention: ending.intervention ?? null,
      missingVariable: ending.missingVariable ?? null,
      reason:
        ending.ending === "done"
          ? ending.reason
          : `Step ${steps.length}: ${ending.reason}`,
      snapshot: progress.latest?.snapshot ?? null,
      steps,
      url: progress.latest?.url ?? null,
    } satisfies AgentPursuitResult;
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
                "This operation id already pursued different steps. Use a new operation id. (agent_session_conflict)",
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
