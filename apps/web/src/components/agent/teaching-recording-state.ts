import type { TeachingCaptureState } from "@contingency/protocol";

/**
 * The user gestures that move a Teaching Recording. Start and Stop are the
 * whole privacy boundary (ADR 0039): nothing is captured before Start, and
 * every capture source ends at Stop.
 */
export type TeachingRecordingGesture = "start" | "stop";

export interface TeachingRecordingAction {
  /**
   * What a screen reader announces. It contains the visible label, so the
   * button still satisfies label-in-name.
   */
  readonly accessibleName: string;
  readonly gesture: TeachingRecordingGesture;
  readonly label: string;
}

export interface TeachingRecordingPresentation {
  /** The one action this state offers, or `null` when it offers none. */
  readonly action: TeachingRecordingAction | null;
  /** The short state name beside the Flow Skill, never a raw recording id. */
  readonly badge: string;
  /** What the user can do next, in one sentence. */
  readonly nextStep: string;
  /** Whether this state shows a live elapsed timer. */
  readonly showsElapsed: boolean;
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

/**
 * How the Workspace presents one Teaching capture state. The names and
 * sentences come from the settled #185 prototype state contract.
 *
 * States from `learning` onward are rendered honestly but without controls:
 * the learning, dry-run, and verification actions belong to their own work,
 * and a disabled repeat of the previous action is not a status.
 */
export const teachingRecordingPresentation = (
  captureState: TeachingCaptureState
): TeachingRecordingPresentation => {
  switch (captureState._tag) {
    case "setup": {
      return {
        action: START,
        badge: "Not recording",
        nextStep:
          "Sign in, pick emulation, and edit storage. Nothing is captured until you start recording.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "recording": {
      return {
        action: STOP,
        badge: "Recording",
        nextStep:
          "Do the journey once. Press stop on the page that proves it worked.",
        showsElapsed: true,
        tone: "recording",
      };
    }
    case "finalizing": {
      return {
        action: null,
        badge: "Saving",
        nextStep:
          "Writing video, trace, and actions. This takes a few seconds.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "ready": {
      return {
        action: START,
        badge: "Recording saved",
        nextStep:
          "Ask an agent to learn this recording, or start another recording in the same browser setup.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "learning": {
      return {
        action: null,
        badge: "Learning",
        nextStep:
          "Keep using the browser. The flow skill appears here when it is drafted.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "skill-drafted": {
      return {
        action: null,
        badge: "Flow skill drafted",
        nextStep: `The agent saved the flow skill to ${captureState.skillPath}.`,
        showsElapsed: false,
        tone: "default",
      };
    }
    case "dry-running": {
      return {
        action: null,
        badge: "Dry run",
        nextStep: "The flow skill is running in a fresh browser.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "dry-run-passed": {
      return {
        action: null,
        badge: "Dry run passed",
        nextStep: "The recording is kept until the flow is verified.",
        showsElapsed: false,
        tone: "default",
      };
    }
    case "verified": {
      return {
        action: null,
        badge: "Recording deleted",
        nextStep: "The flow skill and its references are all that is left.",
        showsElapsed: false,
        tone: "default",
      };
    }
    default: {
      return {
        action: START,
        badge: "Recording failed",
        nextStep: `${captureState.error} You can start another recording in this browser setup.`,
        showsElapsed: false,
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
