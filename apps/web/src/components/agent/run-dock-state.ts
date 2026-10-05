import type {
  AgentRunState,
  AgentRunStep,
  AgentSessionSnapshot,
  TaskAgentRunState,
} from "@contingency/protocol";
import { isLiveAgentSessionPhase } from "@contingency/protocol";

import {
  agentControlPresentation,
  agentStatusLabel,
  isInteractiveRunSession,
} from "@/components/agent/agent-workspace-state";

/** One Agent Session that is running or rehearsing rather than teaching. */
export type RunSessionSnapshot = Extract<
  AgentSessionSnapshot,
  { readonly activity: "run" }
>;

/**
 * How long the agent may go without calling a tool before the dock says so.
 * It is a notice only: a Run has no wall-clock ceiling and nothing ends it for
 * being idle
 * ([ADR 0043](../../../../docs/adr/0043-agent-runs-have-no-wall-clock-ceiling.md)).
 */
export const AGENT_IDLE_NOTICE_MS = 10 * 60_000;

/**
 * The idle notice for a live Run whose agent holds the browser, or
 * `undefined` when there is nothing to say. While the user holds control, or
 * the agent has asked for a Takeover, the agent is waiting on the user, so its
 * silence is not idleness. The Runner restarts the idle time when control
 * comes back.
 */
export const agentIdleNotice = (
  session: {
    readonly controller: RunSessionSnapshot["controller"];
    readonly phase: RunSessionSnapshot["phase"];
    readonly run:
      | Pick<AgentRunState, "lastAgentActivityAt" | "outcome">
      | TaskAgentRunState
      | null;
  },
  now: number,
  thresholdMs: number = AGENT_IDLE_NOTICE_MS
): string | undefined => {
  const { run } = session;
  if (
    run === null ||
    ("lifecycle" in run
      ? run.lifecycle.phase === "ended"
      : run.outcome !== null) ||
    session.controller !== "agent" ||
    session.phase === "takeover"
  ) {
    return undefined;
  }
  const idleMs = now - Date.parse(run.lastAgentActivityAt);
  if (!(idleMs >= thresholdMs)) {
    return undefined;
  }
  return `Agent idle for ${Math.floor(idleMs / 60_000)} min`;
};

/**
 * The Agent Step a live Interactive Run is on, in full. It is deliberately
 * kept out of the dock's own sentence: a step's name and its whole
 * `Done when:` clause are paragraphs, and a dock is one row (#238).
 */
export interface RunDockStep {
  /** What the Agent Step is judged against, verbatim. */
  readonly doneWhen: string;
  /** `Agent Step 6 of 6`, short enough to sit on a control. */
  readonly label: string;
  readonly name: string;
}

export interface RunDockPresentation {
  /** The short state name beside the session, never a raw session id. */
  readonly badge: string;
  /** How far the Run got, or `undefined` when there are no Agent Steps yet. */
  readonly coverage: string | undefined;
  /** Where the user is and what happens next, in whole sentences. */
  readonly nextStep: string;
  /** The active Agent Step's detail, or `undefined` when none is running. */
  readonly step: RunDockStep | undefined;
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
  // Only a Run persisted while Runs had wall-clock ceilings carries this.
  "timed-out": { failed: true, sentence: "The run timed out." },
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
 * Where an ended Interactive Run's evidence went. The Workspace keeps the Run
 * on screen with its Run Summary docked beside it until the user moves on.
 */
const endedRunSentences = (session: RunSessionSnapshot): readonly string[] =>
  isInteractiveRunSession(session) && !isLiveAgentSessionPhase(session.phase)
    ? ["The Run has ended. Its Run Summary is beside the browser."]
    : [];

/**
 * How the Workspace dock presents one live Run session. A Dry Run names the
 * Flow Skill it rehearses and what it changed; an Interactive Run names the
 * flow and which Agent Step it is on. Both end with who holds the browser,
 * because the dock's one control exchanges exactly that (#209).
 *
 * The Agent Step's name and its `Done when:` clause travel in `step` rather
 * than in the sentence: they are the two longest strings the dock ever sees,
 * and the dock shows them behind the step counter instead (#238).
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
  let step: RunDockStep | undefined;
  let failed = session.phase === "failed" || session.phase === "interrupted";

  if (dryRun === null) {
    if (run === null) {
      sentences.push("This session has no flow skill run yet.");
    } else if ("schemaVersion" in run) {
      sentences.push(run.instructions.at(-1)?.instruction ?? run.requestedTask);
    } else {
      sentences.push(`Running the flow skill ${run.flowSkillName}.`);
      const active = activeStep(run);
      if (active === undefined) {
        const outcome =
          run.outcome === null ? undefined : RUN_OUTCOME[run.outcome];
        if (outcome !== undefined) {
          sentences.push(outcome.sentence);
          failed ||= outcome.failed;
        }
      } else {
        const label = `Agent Step ${active.index + 1} of ${run.steps.length}`;
        step = { doneWhen: active.doneWhen, label, name: active.name };
        sentences.push(`${label}.`);
      }
    }
  } else {
    sentences.push(
      `Rehearsing the flow skill ${dryRun.flowSkillName}.`,
      changedInputsSentence(dryRun.inputs)
    );
    if (run !== null && "schemaVersion" in run) {
      sentences.push(run.instructions.at(-1)?.instruction ?? run.requestedTask);
    }
  }

  sentences.push(...endedRunSentences(session), `${control.holder}.`);
  if (control.reason !== undefined) {
    sentences.push(control.reason);
  }

  return {
    badge: agentStatusLabel(session, streamConnected),
    coverage:
      run === null || "schemaVersion" in run
        ? undefined
        : `${run.coverage.executed} of ${run.coverage.total} Agent Steps executed`,
    nextStep: sentences.join(" "),
    step,
    tone: failed ? "failed" : "default",
  };
};
