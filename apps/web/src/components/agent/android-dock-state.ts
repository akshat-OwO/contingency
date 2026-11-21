/**
 * How an Android session reads in the Workspace dock, on the browser dock's
 * own state names and gestures (#487).
 */
import type {
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";

import { androidDeviceLabel } from "@/components/agent/android-workspace-state";
import { teachingRecordingPresentation } from "@/components/agent/teaching-recording-state";
import type { FlowsSessionView } from "@/components/catalog/flows-page-state";

import type { DockStateTone } from "./workspace-dock";

/** What a native session does, as its picker row says it. */
export const NATIVE_KIND_LABEL: Record<
  AndroidWorkspaceSummary["kind"],
  string
> = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
};

/**
 * An Android session reads like a browser one in the session picker: the Flow
 * Flow name first, then what the session is doing with it, marked Android so
 * the two platforms never share a label.
 */
export const androidSessionLabel = (
  session: Pick<AndroidWorkspaceSummary, "flowName" | "kind">
): string => `${session.flowName} · Android ${NATIVE_KIND_LABEL[session.kind]}`;

/**
 * The picker trigger's label, as the prototype's: the Flow, then what the
 * session does with it, or the bare Flow while teaching. The platform glyph
 * beside it says which device it runs on.
 */
export const nativeSessionTitle = (
  session: Pick<AndroidWorkspaceSummary, "flowName" | "kind">
): string =>
  session.kind === "teaching"
    ? session.flowName
    : `${session.flowName} · ${NATIVE_KIND_LABEL[session.kind]}`;

/** What the Flows page needs to know about an Android session. */
export const androidFlowsSessionView = (
  session: AndroidWorkspaceSnapshot
): FlowsSessionView =>
  session.kind === "teaching"
    ? {
        activity: "teaching",
        captureState: session.captureState?._tag ?? "setup",
        flowName: session.flowName,
      }
    : {
        activity: "run",
        dryRun: session.kind === "dry-run",
        flowNames: [session.flowName],
      };

/** Whether the session still owns its device. */
export const isLiveAndroidSession = (
  session: AndroidWorkspaceSummary
): boolean =>
  session.phase === "pending" ||
  session.phase === "running" ||
  session.phase === "paused";

/**
 * A Dry Run or Run that finished or was closed: it keeps its last frame and
 * Run Summary, and the status island offers Task details and Done (#757).
 */
export const isEndedNativeRun = (
  session: Pick<AndroidWorkspaceSummary, "kind" | "phase">
): boolean =>
  session.kind !== "teaching" &&
  (session.phase === "completed" || session.phase === "closed");

/** The prototype's sentence while the agent drives a native Run. */
export const AGENT_RUNNING_SENTENCE =
  "The agent is following the Flow on its own. Take control at any time; the agent waits until you return it.";

/** The prototype's sentence for an ended native Run. */
export const ENDED_RUN_SENTENCE = "The Run ended. Its summary is beside it.";

/**
 * The one gesture a dock state offers. Each value is one Android Workspace
 * command, so a label never claims something the protocol cannot do.
 */
export type AndroidDockGesture =
  | "prepare"
  | "recover"
  | "start-recording"
  | "stop-recording"
  | "take-control"
  | "return-control"
  | "verify-flow"
  | "retry-cleanup";

/**
 * Each primary action's tone, as the prototype's buttons and the Web dock:
 * Start recording is filled red because it begins capture; the rest, Stop
 * included, are filled neutral.
 */
export const nativeActionClassName = (gesture: AndroidDockGesture): string =>
  gesture === "start-recording"
    ? "bg-status-recording hover:bg-status-recording/90 ml-auto text-white"
    : "ml-auto";

export interface AndroidDockAction {
  readonly accessibleName: string;
  readonly gesture: AndroidDockGesture;
  readonly label: string;
}

export interface AndroidDockPresentation {
  readonly action: AndroidDockAction | null;
  readonly badge: string;
  readonly nextStep: string;
  /** Whether the dock offers Reject flow beside the primary action. */
  readonly rejectable: boolean;
  /** Whether a live recording can take an instruction. */
  readonly showsComment: boolean;
  readonly tone: DockStateTone;
}

const action = (
  gesture: AndroidDockGesture,
  label: string,
  accessibleName = label
): AndroidDockAction => ({ accessibleName, gesture, label });

const OUTCOME_LABEL: Record<
  NonNullable<AndroidWorkspaceSummary["assessment"]>["outcome"],
  string
> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

/**
 * The tone of an ended session's verdict. Blocked and inconclusive are not
 * broken journeys; they ask the person to look, as the Run Summary does.
 */
const COMPLETED_TONE: Record<
  NonNullable<AndroidWorkspaceSummary["assessment"]>["outcome"] | "none",
  DockStateTone
> = {
  blocked: "attention",
  inconclusive: "attention",
  none: "default",
  "not-working": "failed",
  working: "success",
};

/** Capture states whose decision outlives the session that reached them. */
const DECIDED = new Set(["dry-run-passed", "dry-run-failed", "verified"]);

const quiet = (
  badge: string,
  nextStep: string,
  tone: AndroidDockPresentation["tone"] = "default"
): AndroidDockPresentation => ({
  action: null,
  badge,
  nextStep,
  rejectable: false,
  showsComment: false,
  tone,
});

export const hasPreparedAndroidSession = (session: AndroidWorkspaceSnapshot) =>
  session.preparation.evidence.some((event) => event.type === "observation");

const pausedPreparationAction = (session: AndroidWorkspaceSnapshot) =>
  hasPreparedAndroidSession(session)
    ? action("recover", "Recover same emulator")
    : action("prepare", "Retry preparation");

/**
 * The Teaching states, on the browser's own names and gestures. The sentences
 * that name the browser are said about the device instead; the rest are
 * platform-neutral and come from the browser presentation unchanged.
 */
const teachingPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation => {
  const captureState = session.captureState ?? {
    _tag: "setup" as const,
    requestedAt: session.startedAt,
  };
  const browser = teachingRecordingPresentation(
    captureState,
    session.cleanup ?? undefined,
    session.controller,
    "running"
  );
  const base: AndroidDockPresentation = {
    action: null,
    badge: browser.badge,
    nextStep: browser.nextStep,
    rejectable: browser.secondaries.includes("reject-flow"),
    showsComment: false,
    tone: browser.tone,
  };
  switch (captureState._tag) {
    case "setup": {
      return session.controller === "agent"
        ? {
            ...base,
            nextStep: `The agent is preparing the emulator. Start recording appears when it hands you control; nothing is captured before then.`,
          }
        : {
            ...base,
            action: action("start-recording", "Start recording"),
            nextStep:
              "Get the Target App to its starting screen. Nothing is captured until you start recording.",
          };
    }
    case "recording": {
      return {
        ...base,
        action: action("stop-recording", "Stop", "Stop recording"),
        nextStep:
          "Tap through the journey once. Stop on the screen that proves it worked.",
        showsComment: true,
      };
    }
    case "ready": {
      return {
        ...base,
        nextStep:
          "Ask an agent to learn this recording. A new recording needs a new Android session.",
      };
    }
    case "learning": {
      return {
        ...base,
        nextStep: "The Flow appears in Flows when it is drafted.",
      };
    }
    case "dry-running": {
      return {
        ...base,
        nextStep: "The Flow is running in its own Android Dry Run.",
      };
    }
    case "dry-run-passed": {
      return browser.action?.gesture === "verify-flow"
        ? { ...base, action: action("verify-flow", "Verify flow") }
        : base;
    }
    case "verified": {
      return browser.action?.gesture === "retry-cleanup"
        ? { ...base, action: action("retry-cleanup", "Retry cleanup") }
        : base;
    }
    case "failed": {
      return {
        ...base,
        nextStep: `${captureState.error} Start a new Android session to record again.`,
      };
    }
    default: {
      return base;
    }
  }
};

const controlPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation => {
  if (session.controller === "user") {
    return {
      ...quiet(
        "You have control",
        session.kind === "dry-run"
          ? `You hold the emulator. This Dry Run cannot pass after Takeover; return control when you are done.`
          : `You hold the emulator. Return control when you are done.`,
        "live"
      ),
      action: action("return-control", "Return control"),
    };
  }
  // The prototype's Running chip and sentence. A native Run reports no Agent
  // Step count, so the chip carries the still progress ring without `n/m`.
  return {
    ...quiet("Running", AGENT_RUNNING_SENTENCE, "busy"),
    action: action("take-control", "Take control"),
  };
};

/**
 * An ended Dry Run or Run, as the Web ended Run reads (#757): the chip says
 * only `Ended`, because the verdict is the Run Summary's. A decision the
 * recording still waits on, Verify flow, Reject flow or Retry cleanup,
 * outlives the session, so its action and sentence stay.
 */
const endedRunPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation => {
  const decision =
    session.captureState !== null && DECIDED.has(session.captureState._tag)
      ? teachingPresentation(session)
      : undefined;
  const decides =
    decision !== undefined && (decision.action !== null || decision.rejectable);
  return {
    ...quiet(
      "Ended",
      decides ? decision.nextStep : ENDED_RUN_SENTENCE,
      "ended"
    ),
    action: decides ? decision.action : null,
    rejectable: decides && decision.rejectable,
  };
};

/** A session waiting on preparation, or on a decision before it. */
const pendingPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation =>
  session.preparation.pending.length > 0
    ? quiet(
        "Decision needed",
        "Answer the request above before the emulator is prepared.",
        "attention"
      )
    : {
        ...quiet(
          "Not prepared",
          `Prepare ${androidDeviceLabel(session.selection.device)} to show it here. Nothing is captured until you start recording.`
        ),
        action: action(
          "prepare",
          `Prepare emulator`,
          `Prepare selected emulator`
        ),
      };

/**
 * How the Android dock presents one session. It mirrors the browser dock: a
 * state badge, one sentence on what happens next, and at most one primary
 * action. Android adds only what a device needs first: preparing it, the Run
 * Environment Permission, and recovering the same device after a pause.
 */
export const androidDockPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation => {
  if (isEndedNativeRun(session)) {
    return endedRunPresentation(session);
  }
  // Verification and Cleanup stay reachable after the session ends.
  if (session.captureState !== null && DECIDED.has(session.captureState._tag)) {
    return teachingPresentation(session);
  }
  switch (session.phase) {
    case "pending": {
      return pendingPresentation(session);
    }
    case "paused": {
      if (session.boundary?.reason === "confirmation") {
        return {
          ...quiet(
            "Confirmation needed",
            "Allow or refuse the exact action attempt above.",
            "attention"
          ),
          action:
            session.controller === "user"
              ? action("return-control", "Return control")
              : action("take-control", "Take control"),
        };
      }
      return {
        ...quiet(
          "Paused",
          session.error ??
            "Execution is paused. Recover the same emulator to carry on.",
          "attention"
        ),
        action: pausedPreparationAction(session),
      };
    }
    case "refused": {
      return quiet(
        "Refused",
        session.error ??
          `The Run Environment Permission was refused, so this session never used the emulator.`,
        "failed"
      );
    }
    case "closed": {
      return quiet(
        "Closed",
        "This session released its emulator. Start a new Android session to record or run again."
      );
    }
    case "completed": {
      const { assessment } = session;
      return quiet(
        assessment === null ? "Completed" : OUTCOME_LABEL[assessment.outcome],
        assessment?.explanation ?? "The Run Summary is beside the device.",
        COMPLETED_TONE[assessment?.outcome ?? "none"]
      );
    }
    default: {
      return session.kind === "teaching"
        ? teachingPresentation(session)
        : controlPresentation(session);
    }
  }
};
