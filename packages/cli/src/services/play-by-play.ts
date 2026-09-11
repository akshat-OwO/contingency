import type {
  CapturedAction,
  TeachingInstruction,
  UrlTransition,
} from "@contingency/protocol";

import type { Demonstration } from "./agent-flow-compiler.ts";

/**
 * How many timeline lines one stub PlayByPlay keeps. The prose exists to be
 * read by the compiling agent, so it stays shorter than the captured evidence
 * it summarizes; the oldest lines are dropped first, like the capture limits.
 */
const LINE_LIMIT = 400;

/**
 * What the stub says before its timeline, so a reader never mistakes derived
 * prose for the video-analysis pass ADR 0038 describes.
 */
const PROVISIONAL_NOTE =
  "Provisional PlayByPlay derived from captured actions, URL transitions, and relayed Instructions. The video-analysis pass that will replace it is not implemented yet.";

/** One thing that happened, as the narrative orders it. */
interface TimelineEvent {
  readonly at: string;
  readonly sentence: string;
}

const actorName = (actor: CapturedAction["actor"]): string =>
  actor === "user" ? "The user" : "The agent";

const outcomeSuffix = (outcome: CapturedAction["outcome"]): string => {
  if (outcome === "completed") {
    return "";
  }
  return outcome === "failed" ? ", which failed" : `, which was ${outcome}`;
};

const actionSentence = (action: CapturedAction): string => {
  const moved =
    action.urlAfter === action.urlBefore
      ? ""
      : `, taking the Page to ${action.urlAfter}`;
  return `${actorName(action.actor)} ${action.description}${outcomeSuffix(action.outcome)}${moved}.`;
};

const transitionSentence = (transition: UrlTransition): string =>
  `The Page moved from ${transition.from} to ${transition.to} without a captured action.`;

const instructionSentence = (instruction: TeachingInstruction): string =>
  `The user said: "${instruction.text}".`;

/**
 * The stub PlayByPlay for a Demonstration: one prose timeline of what the
 * Teaching session observed, ordered by when each event happened. It is the
 * leading field of every Teaching Feed response, so it is never empty — a
 * Demonstration with nothing captured yet says so.
 */
export const stubPlayByPlay = (
  demonstration: Demonstration,
  initialUrl: string
): string => {
  const events: TimelineEvent[] = [
    ...demonstration.actions.map((action) => ({
      at: action.at,
      sentence: actionSentence(action),
    })),
    // A transition an action caused is already narrated by that action, so
    // only the ones nothing claimed become their own line.
    ...demonstration.urlTransitions.flatMap((transition) =>
      transition.actionId === null
        ? [{ at: transition.at, sentence: transitionSentence(transition) }]
        : []
    ),
    ...demonstration.instructions.map((instruction) => ({
      at: instruction.at,
      sentence: instructionSentence(instruction),
    })),
  ].toSorted((left, right) => left.at.localeCompare(right.at));
  const timeline = events.slice(Math.max(0, events.length - LINE_LIMIT));
  const opening = `Teaching started on ${initialUrl}.`;
  const body =
    timeline.length === 0
      ? ["Nothing has been captured yet."]
      : timeline.map(({ sentence }) => sentence);
  return [PROVISIONAL_NOTE, opening, ...body].join("\n");
};
