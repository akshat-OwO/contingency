import type {
  AgentRunState,
  AgentRunStep,
  AgentSessionSnapshot,
} from "@contingency/protocol";

import {
  agentControlPresentation,
  agentStatusLabel,
} from "@/components/agent/agent-workspace-state";

/** One Agent Session that is running or rehearsing rather than teaching. */
export type RunSessionSnapshot = Extract<
  AgentSessionSnapshot,
  { readonly activity: "run" }
>;

/**
 * The secondary actions a live Run offers. Raising a ceiling is deliberately
 * only ever a direct user gesture — there is no MCP tool for it, so a stuck
 * agent cannot buy itself more time
 * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
export type RunDockSecondary = "extend-run-ceiling" | "extend-step-ceiling";

export interface RunDockPresentation {
  /** The short state name beside the session, never a raw session id. */
  readonly badge: string;
  /** How far the Run got, or `undefined` when there are no Agent Steps yet. */
  readonly coverage: string | undefined;
  /** Where the user is and what happens next, in whole sentences. */
  readonly nextStep: string;
  /** The secondary actions beside the one control, in dock order. */
  readonly secondaries: readonly RunDockSecondary[];
  readonly tone: "default" | "failed";
}

const RUN_OUTCOME: Record<
  NonNullable<AgentRunState["outcome"]>,
  { readonly failed: boolean; readonly sentence: string }
> = {
  completed: { failed: false, sentence: "Every Agent Step was assessed." },
  "ended-early": {
    failed: true,
    sentence: "An Agent Step was not working, so the run ended early.",
  },
  interrupted: { failed: true, sentence: "The run was interrupted." },
  "timed-out": {
    failed: true,
    sentence: "A ceiling was reached, so the run timed out.",
  },
};

const activeStep = (run: AgentRunState): AgentRunStep | undefined =>
  run.activeStepIndex === null
    ? undefined
    : run.steps.find(({ index }) => index === run.activeStepIndex);

/**
 * How the Dry Run's inputs read in one clause. A rehearsal only means
 * something when at least one input differs from the recorded journey, so the
 * changed ones are named and a rehearsal with none says so.
 */
const changedInputsSentence = (
  inputs: readonly {
    readonly changed: boolean;
    readonly name: string;
  }[]
): string => {
  const changed = inputs.filter((input) => input.changed);
  return changed.length === 0
    ? "It is running the recorded inputs unchanged."
    : `Changed inputs: ${changed.map(({ name }) => name).join(", ")}.`;
};

/**
 * How the Workspace dock presents one live Run session. A Dry Run names the
 * Flow Skill it rehearses and what it changed; an Interactive Run names the
 * flow, the Agent Step it is on, and the `Done when:` line that Step is judged
 * against. Both end with who holds the browser, because the dock's one control
 * exchanges exactly that (#209).
 */
export const runDockPresentation = (
  session: RunSessionSnapshot,
  streamConnected: boolean
): RunDockPresentation => {
  const control = agentControlPresentation(session);
  /*
    A snapshot from an older MCP process can arrive without `dryRun`: the
    schema fills it in on decode, and reading it defensively keeps a dock that
    has to render either way from throwing over a missing key.
  */
  const dryRun = session.dryRun ?? null;
  const { run } = session;
  const sentences: string[] = [];
  let failed = session.phase === "failed" || session.phase === "interrupted";

  if (dryRun === null) {
    if (run === null) {
      sentences.push("This session has no flow skill run yet.");
    } else {
      sentences.push(`Running the flow skill ${run.flowSkillName}.`);
      const step = activeStep(run);
      if (step === undefined) {
        const outcome =
          run.outcome === null ? undefined : RUN_OUTCOME[run.outcome];
        if (outcome !== undefined) {
          sentences.push(outcome.sentence);
          failed ||= outcome.failed;
        }
      } else {
        sentences.push(
          `Agent Step ${step.index + 1} of ${run.steps.length}: ${step.name}.`,
          `Done when: ${step.doneWhen}`
        );
      }
    }
  } else {
    sentences.push(
      `Rehearsing the flow skill ${dryRun.flowSkillName}.`,
      changedInputsSentence(dryRun.inputs)
    );
  }

  sentences.push(`${control.holder}.`);
  if (control.reason !== undefined) {
    sentences.push(control.reason);
  }

  return {
    badge: agentStatusLabel(session, streamConnected),
    coverage:
      run === null
        ? undefined
        : `${run.coverage.executed} of ${run.coverage.total} Agent Steps executed`,
    nextStep: sentences.join(" "),
    secondaries:
      run === null || run.outcome !== null
        ? []
        : ["extend-step-ceiling", "extend-run-ceiling"],
    tone: failed ? "failed" : "default",
  };
};
