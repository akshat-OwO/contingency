import type {
  AgentExecutionBoundary,
  AgentSessionSnapshot,
} from "@contingency/protocol";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";
import { takesExampleVariables } from "./run-provenance";
import { hasRuntimeVariableNotice } from "./runtime-variable-state";

/**
 * Everything the agent can be waiting on the user for, as the Requests island
 * lists it. Each entry carries the one line a collapsed island keeps, and a
 * key naming exactly what is being asked, so collapsing hides that request
 * and a new one opens the island again.
 */
export interface DockRequest {
  readonly key: string;
  readonly kind:
    | "guided-run-questions"
    | "boundary"
    | "dry-run-secrets"
    | "runtime-variables"
    | "setup-variables"
    | "takeover-variable";
  /** What is asked, in a few words: the action, or how many inputs remain. */
  readonly summary: string;
  readonly title: string;
  /**
   * Whether it still waits on the user. A settled request, such as answered
   * Guided Run questions, stays readable but queues behind open ones.
   */
  readonly waiting: boolean;
}

/**
 * The question an Execution Boundary puts to the user, as the prototype asks
 * it (#753). The eyebrow already says it is an Execution Boundary.
 */
export const boundaryTitle: Record<AgentExecutionBoundary["reason"], string> = {
  confirmation: "Allow the agent to take this action?",
  domain: "Allow the agent to visit a new host?",
  objective: "Allow the agent to act outside the objective?",
};

/**
 * Splits inputs into those still waiting and those already answered, in one
 * pass, keeping each side in its original order.
 */
export const splitWaiting = <Input>(
  inputs: readonly Input[],
  isWaiting: (input: Input) => boolean
): readonly [waiting: readonly Input[], answered: readonly Input[]] => {
  const waiting: Input[] = [];
  const answered: Input[] = [];
  for (const input of inputs) {
    (isWaiting(input) ? waiting : answered).push(input);
  }
  return [waiting, answered];
};

/**
 * How many of a request's inputs still wait, as every Variable card's eyebrow
 * and a collapsed island's line read it.
 */
export const stillNeeded = (waiting: number, total: number) =>
  waiting === 0 ? "All answered" : `${waiting} of ${total} needed`;

/**
 * The runtime Variables a Workspace Variable card holds: the pending supply
 * decisions, and the Variables already answered that no longer wait.
 */
export const runtimeVariables = (session: AgentSessionSnapshot) => {
  const pending = (session.pendingDecisions ?? []).filter(
    (decision) => decision.kind === "supply_variable"
  );
  const pendingScopes = new Set(
    pending.map((decision) =>
      JSON.stringify([decision.variable?.flowName, decision.variable?.name])
    )
  );
  const answers =
    session.run !== null && "schemaVersion" in session.run
      ? session.run.variables.filter(
          (variable) =>
            variable.lastAnswer !== undefined &&
            !pendingScopes.has(
              JSON.stringify([variable.flowName, variable.name])
            )
        )
      : [];
  return { answers, pending };
};

/** The heading a runtime Variable request takes, by who answers it where. */
export const runtimeVariablesTitle = (session: AgentSessionSnapshot) => {
  if (session.dryRun?.flowName !== undefined) {
    return "Prerequisite Variables";
  }
  if (takesExampleVariables(session)) {
    return "Example private inputs";
  }
  return "Inputs needed";
};

const boundaryRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  const { boundary } = session;
  if (
    !hasExecutionBoundaryNotice(session) ||
    boundary === undefined ||
    boundary === null
  ) {
    return undefined;
  }
  return {
    key: `boundary:${boundary.id}`,
    kind: "boundary",
    summary: boundary.requested,
    title: boundaryTitle[boundary.reason],
    waiting: true,
  };
};

const setupVariablesRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  const variables = session.setupVariables ?? [];
  if (
    session.activity !== "teaching" ||
    session.controller !== "agent" ||
    session.captureState._tag !== "setup" ||
    variables.length === 0
  ) {
    return undefined;
  }
  const [waiting] = splitWaiting(
    variables,
    ({ status }) => status === "requested"
  );
  return {
    key: `setup:${waiting.map(({ requestId }) => requestId).join(",")}`,
    kind: "setup-variables",
    summary: stillNeeded(waiting.length, variables.length),
    title: "Setup Variables",
    waiting: waiting.length > 0,
  };
};

const runtimeVariablesRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  if (!hasRuntimeVariableNotice(session)) {
    return undefined;
  }
  const { answers, pending } = runtimeVariables(session);
  return {
    key: `variables:${pending.map(({ pendingDecisionId }) => pendingDecisionId).join(",")}`,
    kind: "runtime-variables",
    summary: stillNeeded(pending.length, pending.length + answers.length),
    title: runtimeVariablesTitle(session),
    waiting: pending.length > 0,
  };
};

const dryRunSecretsRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  const variables =
    session.activity === "run" ? (session.dryRun?.variables ?? []) : [];
  const [waiting] = splitWaiting(variables, ({ supplied }) => !supplied);
  /*
    A supplied secret needs nothing more from the user, so once every one is
    supplied the request leaves the dock instead of lingering for the rest of
    the Run.
  */
  if (waiting.length === 0) {
    return undefined;
  }
  return {
    key: `secrets:${waiting.map(({ name }) => name).join(",")}`,
    kind: "dry-run-secrets",
    summary: stillNeeded(waiting.length, variables.length),
    title: "Dry Run Variables",
    waiting: true,
  };
};

const questionsRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  if (session.activity !== "teaching" || session.origin !== "guided-run") {
    return undefined;
  }
  const questions = session.teaching.instructions.filter(
    (item) => item.dialogue?._tag === "question"
  );
  if (questions.length === 0) {
    return undefined;
  }
  const waiting = questions.filter(
    (question) =>
      !session.teaching.instructions.some(
        (item) =>
          item.dialogue?._tag === "answer" &&
          item.dialogue.questionId === question.id
      )
  );
  return {
    key: `questions:${waiting.map(({ id }) => id).join(",")}`,
    kind: "guided-run-questions",
    summary: stillNeeded(waiting.length, questions.length),
    title: "Guided Run questions",
    waiting: waiting.length > 0,
  };
};

/**
 * Whether the user can type a Variable into the page: only while they hold
 * the browser during a Guided recording (ADR 0052, ADR 0065).
 */
export const takesTakeoverVariable = (session: AgentSessionSnapshot) =>
  session.activity === "teaching" &&
  session.origin === "guided-run" &&
  session.captureState._tag === "recording" &&
  session.controller === "user";

/**
 * The Takeover Variable form's state. The request tier owns it, so folding
 * Requests away keeps the typed name and the Entered list.
 */
export interface TakeoverForm {
  readonly entered: readonly string[];
  readonly error: string;
  readonly invalid: boolean;
  readonly name: string;
  readonly pending: boolean;
  readonly value: string;
}

export const emptyTakeoverForm: TakeoverForm = {
  entered: [],
  error: "",
  invalid: false,
  name: "",
  pending: false,
  value: "",
};

/** Names the Takeover a Takeover Variable form belongs to. */
export const takeoverKey = (session: AgentSessionSnapshot) =>
  takesTakeoverVariable(session)
    ? `${session.id}:${session.takeover?.requestedAt ?? "user"}`
    : `${session.id}:none`;

const takeoverVariableRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined =>
  takesTakeoverVariable(session)
    ? {
        key: `takeover:${session.id}`,
        kind: "takeover-variable",
        summary: "Type a Variable into the focused field",
        title: "Takeover Variable",
        waiting: true,
      }
    : undefined;

/** The requests the Requests island holds, in the order they were asked. */
export const dockRequests = (
  session: AgentSessionSnapshot
): readonly DockRequest[] =>
  [
    questionsRequest(session),
    boundaryRequest(session),
    setupVariablesRequest(session),
    runtimeVariablesRequest(session),
    dryRunSecretsRequest(session),
    takeoverVariableRequest(session),
  ].filter((request) => request !== undefined);

/**
 * The order the Requests island shows its requests in, one at a time (#753):
 * open requests first, then settled ones, each in the order they were asked.
 * A request the user set aside with "more after this" queues behind all of
 * them, in the order it was set aside, so stepping on reaches every request
 * and comes back round.
 */
export const requestQueue = (
  requests: readonly DockRequest[],
  setAside: readonly string[]
): readonly DockRequest[] => {
  const rank = ({ key, waiting }: DockRequest) => {
    const aside = setAside.indexOf(key);
    if (aside !== -1) {
      return 2 + aside;
    }
    return waiting ? 0 : 1;
  };
  return requests
    .map((request, order) => ({ order, rank: rank(request), request }))
    .toSorted(
      (left, right) => left.rank - right.rank || left.order - right.order
    )
    .map(({ request }) => request);
};

/**
 * The requests set aside after stepping past `shown`: it moves behind every
 * other one, and keys no longer asked are dropped.
 */
export const setAsideAfter = (
  requests: readonly DockRequest[],
  setAside: readonly string[],
  shown: DockRequest
): readonly string[] => [
  ...setAside.filter(
    (key) =>
      key !== shown.key && requests.some((request) => request.key === key)
  ),
  shown.key,
];

/**
 * Whether an island collapsed over `collapsedKeys` stays collapsed. Any request
 * the person has not collapsed yet opens it again, so a new Boundary or a new
 * input is never hidden behind an earlier fold.
 */
export const staysCollapsed = (
  requests: readonly DockRequest[],
  collapsedKeys: ReadonlySet<string>
) => requests.every(({ key }) => collapsedKeys.has(key));

/** The few characters of a pending decision id a person needs to match it. */
export const shortDecisionId = (id: string) =>
  id.length <= 20 ? id : `${id.slice(0, 12)}…${id.slice(-4)}`;
