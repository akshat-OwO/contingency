import { isLiveAgentSessionPhase } from "@contingency/protocol";
import type {
  AgentSessionController,
  AgentSessionPhase,
  AgentRunSummary,
  TeachingCaptureState,
  TeachingRecordingCleanupState,
} from "@contingency/protocol";

import {
  dryRunChecksPass,
  isTaskDryRunSummary,
} from "@/components/agent/dry-run-summary-state";
import { failureMessage, isLifecycleRefusal } from "@/lib/failure-message";

/**
 * The user gestures that move a Teaching Recording. Start and Stop are the
 * whole privacy boundary (ADR 0039): nothing is captured before Start, and
 * every capture source ends at Stop.
 *
 * Every value here performs the action its label names. A Dry Run needs
 * changed inputs the dock has no way to collect, so starting one is left to
 * the user's agent rather than a gesture that claims to run something (#210).
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
 * Every value mutates the recording here. Nothing in this union is inert
 * (#210). Handing work to an agent is the user's own prompt, not a dock
 * button (#297).
 */
export type TeachingSecondaryAction =
  | "delete-recording"
  | "reject-flow"
  | "rename-flow";

export interface TeachingRecordingPresentation {
  /** The one action this state offers, or `null` when it offers none. */
  readonly action: TeachingRecordingAction | null;
  /** The short state name beside the Flow Skill, never a raw recording id. */
  readonly badge: string;
  /**
   * What the user can do next, in one sentence. The dock keeps it behind a
   * details button so the dock itself stays one row (#297).
   */
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

/** Historical passes keep their original meaning; task reports require a complete outcome. */
const canVerifyDryRun = (summary: AgentRunSummary | undefined): boolean =>
  summary?.schemaVersion !== 3 ||
  (isTaskDryRunSummary(summary) && dryRunChecksPass(summary));

/**
 * The setup state. An agent-opened session starts with the agent preparing
 * the browser, and a session that ended in setup captured nothing.
 */
const setupPresentation = (
  controller: AgentSessionController,
  phase: AgentSessionPhase
): TeachingRecordingPresentation => {
  // Neither Start nor rename can reach a session that has ended (#268).
  if (!isLiveAgentSessionPhase(phase)) {
    return {
      action: null,
      badge: "Not recorded",
      nextStep: "This session ended before recording started.",
      secondaries: [],
      showsElapsed: false,
      showsInspect: false,
      tone: "default",
    };
  }
  // An agent-opened session starts with the agent preparing the browser.
  // Start belongs to the user, so it appears only after the handoff
  // (ADR 0042).
  if (controller === "agent") {
    return {
      action: null,
      badge: "Agent preparing",
      nextStep:
        "The agent is preparing the browser. Start recording appears when it hands you control; nothing is captured before then.",
      secondaries: ["rename-flow"],
      showsElapsed: false,
      showsInspect: false,
      tone: "default",
    };
  }
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
};

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
  cleanup?: TeachingRecordingCleanupState,
  controller: AgentSessionController = "user",
  phase: AgentSessionPhase = "running"
): TeachingRecordingPresentation => {
  switch (captureState._tag) {
    case "setup": {
      return setupPresentation(controller, phase);
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
        secondaries: ["delete-recording"],
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
        nextStep: "Ask your agent to dry-run the flow with different inputs.",
        secondaries: [],
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
        secondaries: [],
        showsElapsed: false,
        showsInspect: true,
        tone: "failed",
      };
    }
    case "dry-run-passed": {
      if (!canVerifyDryRun(captureState.dryRunSummary)) {
        return {
          action: null,
          badge: "Dry run failed",
          nextStep:
            "This attempt cannot verify the flow. Ask your agent to complete a fresh Dry Run without Takeover.",
          secondaries: ["reject-flow"],
          showsElapsed: false,
          showsInspect: true,
          tone: "failed",
        };
      }
      return {
        action: action("verify-flow", "Verify flow"),
        badge: "Dry run passed",
        nextStep:
          "Verify the flow to keep it and delete the recording. Reject to keep the recording.",
        secondaries: ["reject-flow"],
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
        secondaries: [],
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
