import type {
  TeachingCaptureState,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";

import { failureMessage, isLifecycleRefusal } from "@/lib/failure-message";

/**
 * The user gestures that move a Teaching Recording. Start and Stop are the
 * whole privacy boundary (ADR 0039): nothing is captured before Start, and
 * every capture source ends at Stop.
 *
 * Every value here performs the action its label names. A Dry Run needs
 * changed inputs the dock has no way to collect, so starting one is a named
 * clipboard hand-off among the secondary actions rather than a gesture that
 * claims to run something (#210).
 */
export type TeachingRecordingGesture =
  | "retry-cleanup"
  | "start"
  | "stop"
  | "stop-dry-run"
  | "verify-flow";

export interface TeachingRecordingAction {
  /**
   * What a screen reader announces. It contains the visible label, so the
   * button still satisfies label-in-name.
   */
  readonly accessibleName: string;
  readonly gesture: TeachingRecordingGesture;
  readonly label: string;
}

/**
 * The secondary actions a Teaching state offers. They are not capture
 * gestures: none of them starts or stops capture, so they stay apart from
 * `TeachingRecordingGesture` and the privacy boundary it names.
 *
 * A `copy-` action hands work to the MCP conversation and says so in its
 * label. Every other value mutates the recording here. Nothing in this union
 * is inert (#210).
 */
export type TeachingSecondaryAction =
  | "copy-dry-run-prompt"
  | "copy-failure"
  | "copy-flow-skill-path"
  | "copy-learn-again-prompt"
  | "copy-prompt"
  | "copy-run-prompt"
  | "delete-recording"
  | "reject-flow"
  | "rename-flow";

/**
 * The subset of secondary actions that only fill the clipboard. A clipboard
 * write has no consequence the user can see, so the button that performed it
 * is the only place a confirmation can come from, and these are the actions
 * that need one (#214).
 */
export type TeachingClipboardAction = Extract<
  TeachingSecondaryAction,
  `copy-${string}`
>;

export interface TeachingRecordingPresentation {
  /** The one action this state offers, or `null` when it offers none. */
  readonly action: TeachingRecordingAction | null;
  /** The short state name beside the Flow Skill, never a raw recording id. */
  readonly badge: string;
  /** What the user can do next, in one sentence. */
  readonly nextStep: string;
  /** The secondary actions beside the primary one, in dock order. */
  readonly secondaries: readonly TeachingSecondaryAction[];
  /** Whether this state shows a live elapsed timer. */
  readonly showsElapsed: boolean;
  /**
   * Whether the user can inspect the Page and comment on it. Only a live
   * recording can carry an instruction, so only `recording` offers it here.
   * Correcting a drafted Flow Skill belongs to the learning work.
   */
  readonly showsInspect: boolean;
  readonly tone: "default" | "failed" | "recording";
}

const START: TeachingRecordingAction = {
  accessibleName: "Start recording",
  gesture: "start",
  label: "Start recording",
};

const STOP: TeachingRecordingAction = {
  accessibleName: "Stop recording",
  gesture: "stop",
  label: "Stop",
};

const action = (
  gesture: TeachingRecordingGesture,
  label: string
): TeachingRecordingAction => ({ accessibleName: label, gesture, label });

/**
 * How the Workspace presents one Teaching capture state. The names and
 * sentences come from the settled #185 prototype state contract.
 *
 * `learning` is rendered honestly but without controls: it belongs to the
 * agent, and a disabled repeat of the previous action is not a status. Every
 * state a person can act on carries the one action the prototype settled, so
 * an action the state cannot take is absent rather than disabled.
 */
export const teachingRecordingPresentation = (
  captureState: TeachingCaptureState,
  cleanup?: TeachingRecordingCleanupState
): TeachingRecordingPresentation => {
  switch (captureState._tag) {
    case "setup": {
      return {
        action: START,
        badge: "Not recording",
        nextStep:
          "Sign in, pick emulation, and edit storage. Nothing is captured until you start recording.",
        secondaries: ["rename-flow"],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    case "recording": {
      return {
        action: STOP,
        badge: "Recording",
        nextStep:
          "Do the journey once. Press stop on the page that proves it worked.",
        secondaries: [],
        showsElapsed: true,
        showsInspect: true,
        tone: "recording",
      };
    }
    case "finalizing": {
      return {
        action: null,
        badge: "Saving",
        nextStep:
          "Writing video, trace, and actions. This takes a few seconds.",
        secondaries: [],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    case "ready": {
      return {
        action: START,
        badge: "Recording saved",
        nextStep:
          "Ask an agent to learn this recording, or start another recording in the same browser setup.",
        secondaries: ["copy-prompt", "delete-recording"],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    case "learning": {
      return {
        action: null,
        badge: "Learning",
        nextStep:
          "Keep using the browser. The flow skill appears here when it is drafted.",
        secondaries: [],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    case "skill-drafted": {
      return {
        action: null,
        badge: "Flow skill drafted",
        nextStep:
          "Copy the dry-run prompt and hand it to your agent, which dry-runs the flow with different inputs.",
        secondaries: [
          "copy-dry-run-prompt",
          "copy-flow-skill-path",
          "copy-learn-again-prompt",
        ],
        showsElapsed: false,
        showsInspect: true,
        tone: "default",
      };
    }
    case "dry-running": {
      return {
        action: action("stop-dry-run", "Stop dry run"),
        badge: "Dry run",
        nextStep: "The flow skill is running in a fresh browser.",
        secondaries: [],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    case "dry-run-failed": {
      return {
        action: null,
        badge: "Dry run failed",
        nextStep: captureState.dryRunResult.observableOutcome,
        secondaries: [
          "copy-dry-run-prompt",
          "copy-failure",
          "copy-learn-again-prompt",
        ],
        showsElapsed: false,
        showsInspect: true,
        tone: "failed",
      };
    }
    case "dry-run-passed": {
      return {
        action: action("verify-flow", "Verify flow"),
        badge: "Dry run passed",
        nextStep:
          "Verify the flow to keep it and delete the recording. Reject to keep the recording.",
        secondaries: ["reject-flow", "copy-flow-skill-path"],
        showsElapsed: false,
        showsInspect: true,
        tone: "default",
      };
    }
    case "verified": {
      if (cleanup?._tag === "purge-pending" && cleanup.failure !== null) {
        return {
          action: action("retry-cleanup", "Retry cleanup"),
          badge: "Video and trace still on disk",
          nextStep: `${cleanup.retainedFiles.join(", ")} could not be deleted. Retry the deletion.`,
          secondaries: [],
          showsElapsed: false,
          showsInspect: false,
          tone: "failed",
        };
      }
      if (cleanup?._tag !== "purged") {
        return {
          action: null,
          badge: "Deleting recording",
          nextStep: "The flow is verified. Deleting the temporary recording.",
          secondaries: [],
          showsElapsed: false,
          showsInspect: false,
          tone: "default",
        };
      }
      return {
        action: null,
        badge: "Recording deleted",
        nextStep:
          "The flow skill and its references are all that is left. Run it any time.",
        secondaries: ["copy-run-prompt", "copy-flow-skill-path"],
        showsElapsed: false,
        showsInspect: false,
        tone: "default",
      };
    }
    default: {
      return {
        action: START,
        badge: "Recording failed",
        nextStep: `${captureState.error} You can start another recording in this browser setup.`,
        secondaries: ["delete-recording"],
        showsElapsed: false,
        showsInspect: false,
        tone: "failed",
      };
    }
  }
};

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const MILLISECONDS_PER_SECOND = 1000;

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * The elapsed recording time, derived from the `startedAt` the session pushed
 * rather than from a counter the Workspace keeps: a reconnecting Workspace
 * then shows the recording's real age instead of restarting at zero.
 */
export const elapsedLabel = (startedAt: string, now: number): string => {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return "0:00";
  }
  const total = Math.max(
    0,
    Math.floor((now - started) / MILLISECONDS_PER_SECOND)
  );
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
};

/** The same duration, spoken rather than shown, for the timer's label. */
export const elapsedSpokenLabel = (startedAt: string, now: number): string =>
  `Elapsed recording time ${elapsedLabel(startedAt, now)}`;

/**
 * The prompt the user hands to a learning agent. It names the authoring skills
 * by MCP URI because Contingency serves them itself (ADR 0039): the agent must
 * not fall back to whatever skills its host happens to have installed, and
 * `skill-creator` is never the right tool for a Flow Skill.
 */
export const teachingAgentPrompt = (
  flowSkillName: string,
  recordingId: string
): string =>
  [
    `Learn the Contingency Teaching Recording ${recordingId} and write the Flow Skill "${flowSkillName}" from it.`,
    "",
    "Read these Contingency MCP resources first, then the recording timeline, then save:",
    "- contingency://skill/writing-for-agents",
    "- contingency://skill/writing-for-agents/SKILL-MECHANICS.md",
    "- contingency://skill/technical-writing",
    "- contingency://skill/unslop",
    "",
    'Do not use skill-creator. Claim the recording with agent_teaching_recording_claim action "take", page agent_teaching_timeline_get until nextCursor is null, then call agent_flow_skill_save.',
    "After saving, ask for the inputs again and call agent_flow_skill_dry_run_start with at least one changed input when the task permits it. Drive the returned fresh Agent Session and assess each Agent Step against its Done when line with agent_run_step_assess.",
    "A failure keeps the recording and your claim: fix the package with agent_flow_skill_save under the same claim operation id, then run another Dry Run.",
    "A pass keeps the recording. Ask me to Verify flow or Reject flow, then call agent_flow_skill_decide with the matching decision.",
  ].join("\n");

/**
 * The prompt the user hands to an agent to run a verified Flow Skill. Running
 * is the agent's work: Contingency owns the Step order, the ceilings, and the
 * evidence, but a browser nobody drives finishes nothing, so the Workspace
 * hands over the exact call rather than opening an idle Run.
 */
export const flowSkillRunPrompt = (flowSkillName: string): string =>
  [
    `Run the Contingency flow skill "${flowSkillName}".`,
    "",
    `Call agent_flow_skills_list to find "${
      flowSkillName
    }" in the selected Catalog Root and read the description and declared inputs it reports.`,
    "Ask me for every declared input, then call agent_flow_skill_run_start with those inputs and the page the first step opens.",
    'Drive the returned Agent Session with the browser tools and call agent_run_step_assess for each ordered step, judged against its own "Done when:" line.',
    "Call agent_run_complete when the steps are done or one of them could not be completed.",
  ].join("\n");

/**
 * The prompt the user hands to an agent to dry-run a drafted Flow Skill. A
 * Dry Run needs inputs that differ from the recorded ones, and only the
 * conversation can ask for them, so the Workspace hands over the exact calls
 * instead of starting a Dry Run with the inputs it already has (#210).
 */
export const flowSkillDryRunPrompt = (
  flowSkillName: string,
  recordingId: string
): string =>
  [
    `Dry-run the Contingency Flow Skill "${flowSkillName}", drafted from Teaching Recording ${recordingId}.`,
    "",
    "Read the drafted SKILL.md, ask me for ordinary inputs, and pick at least one value that differs from the recorded journey. For a secret, pass only its name with secret:true; I will supply its value in the Workspace.",
    `Call agent_flow_skill_dry_run_start with recordingId "${recordingId}" and those inputs. Use agent_variable_enter with the secret input's uppercase Variable name after I supply it.`,
    "Drive the returned fresh Agent Session with the browser tools and assess each Agent Step against its Done when line with agent_run_step_assess.",
    "A failure keeps the recording and your claim: fix the package with agent_flow_skill_save under the same claim operation id, then run another Dry Run.",
    "A pass keeps the recording. Ask me to Verify flow or Reject flow, then call agent_flow_skill_decide with the matching decision.",
  ].join("\n");

/** What each gesture is called when a sentence has to name the one that failed. */
const GESTURE_NAME: Record<TeachingRecordingGesture, string> = {
  "retry-cleanup": "Retry cleanup",
  start: "Start recording",
  stop: "Stop",
  "stop-dry-run": "Stop dry run",
  "verify-flow": "Verify flow",
};

/**
 * What the dock says when a gesture does not go through.
 *
 * A refusal the server explained is repeated verbatim: the Teaching store
 * already names the lifecycle it refused from, and that is the sentence the
 * user can act on. A lifecycle refusal is prefixed so the user reads why the
 * button they pressed no longer applies before reading the detail. Anything
 * else names the gesture and the connection, because a dock alert that says
 * nothing is worse than no alert at all (#211).
 */
export const gestureFailureMessage = <Failure>(
  gesture: TeachingRecordingGesture,
  failure: Failure
): string => {
  const name = GESTURE_NAME[gesture];
  const detail = failureMessage(
    failure,
    `The Workspace could not connect, so ${name} did not reach the server.`
  );
  return isLifecycleRefusal(failure)
    ? `${name} no longer applies to this recording. ${detail}`
    : detail;
};
