import type {
  AgentExecutionBoundary,
  AgentSessionSnapshot,
} from "@contingency/protocol";

import { hasExecutionBoundaryNotice } from "./agent-workspace-state";
import { takesExampleVariables } from "./run-provenance";
import { hasRuntimeVariableNotice } from "./runtime-variable-state";

/**
 * Everything the agent can be waiting on the user for, as the dock's first
 * tier lists it. Each entry carries the one line a collapsed tier keeps, and
 * a key naming exactly what is being asked, so collapsing hides that request
 * and a new one opens the tier again.
 */
export interface DockRequest {
  readonly key: string;
  readonly kind:
    | "boundary"
    | "dry-run-secrets"
    | "runtime-variables"
    | "setup-variables";
  /** What is asked, in a few words: the action, or how many inputs remain. */
  readonly summary: string;
  readonly title: string;
}

/**
 * The state badge already reads `Waiting for confirmation`, so the request
 * names what is being confirmed instead of repeating it.
 */
export const boundaryTitle: Record<AgentExecutionBoundary["reason"], string> = {
  confirmation: "Confirm this action",
  domain: "Allow a new domain",
  objective: "Confirm an action outside the objective",
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

const remaining = (waiting: number, total: number) =>
  waiting === 0 ? "All answered" : `${waiting} of ${total} needed`;

/** The heading a runtime Variable request takes, by who answers it where. */
export const runtimeVariablesTitle = (session: AgentSessionSnapshot) => {
  if (session.dryRun?.flowSkillName !== undefined) {
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
    summary: remaining(waiting.length, variables.length),
    title: "Setup Variables",
  };
};

const runtimeVariablesRequest = (
  session: AgentSessionSnapshot
): DockRequest | undefined => {
  if (!hasRuntimeVariableNotice(session)) {
    return undefined;
  }
  const pending = (session.pendingDecisions ?? []).filter(
    ({ kind }) => kind === "supply_variable"
  );
  return {
    key: `variables:${pending.map(({ pendingDecisionId }) => pendingDecisionId).join(",")}`,
    kind: "runtime-variables",
    summary:
      pending.length === 0
        ? "All answered"
        : `${pending.length} ${pending.length === 1 ? "input" : "inputs"} needed`,
    title: runtimeVariablesTitle(session),
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
    summary: remaining(waiting.length, variables.length),
    title: "Dry Run secrets",
  };
};

/** The requests the dock's first tier shows, in the order it shows them. */
export const dockRequests = (
  session: AgentSessionSnapshot
): readonly DockRequest[] =>
  [
    boundaryRequest(session),
    setupVariablesRequest(session),
    runtimeVariablesRequest(session),
    dryRunSecretsRequest(session),
  ].filter((request) => request !== undefined);

/**
 * Whether a tier collapsed over `collapsedKeys` stays collapsed. Any request
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
