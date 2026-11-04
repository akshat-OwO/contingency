/**
 * How an iOS session reads in the Workspace dock, on the browser and Android
 * docks' own state names and gestures. Only the device noun and iOS's two
 * recoveries differ.
 */
import type { IosWorkspaceSnapshot } from "@contingency/protocol";

import { teachingRecordingPresentation } from "@/components/agent/teaching-recording-state";
import type { FlowsSessionView } from "@/components/catalog/flows-drawer-state";

const KIND_LABEL: Record<IosWorkspaceSnapshot["kind"], string> = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
};

/** The session picker label: the Flow, then what the session does, marked iOS. */
export const iosSessionLabel = (
  session: Pick<IosWorkspaceSnapshot, "flowName" | "kind">
): string => `${session.flowName} · iOS ${KIND_LABEL[session.kind]}`;

/** What the Flows drawer needs to know about an iOS session. */
export const iosFlowsSessionView = (
  session: IosWorkspaceSnapshot
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

/** Whether the session still owns its simulator. */
export const isLiveIosSession = (
  session: Pick<IosWorkspaceSnapshot, "phase">
): boolean =>
  session.phase === "pending" ||
  session.phase === "running" ||
  session.phase === "paused";

export type IosDockGesture =
  | "prepare"
  | "recover"
  | "return-to-target-app"
  | "start-recording"
  | "stop-recording"
  | "take-control"
  | "return-control"
  | "verify-flow"
  | "retry-cleanup";

export interface IosDockAction {
  readonly accessibleName: string;
  readonly gesture: IosDockGesture;
  readonly label: string;
}

export interface IosDockPresentation {
  readonly action: IosDockAction | null;
  readonly badge: string;
  readonly nextStep: string;
  readonly rejectable: boolean;
  readonly showsComment: boolean;
  readonly tone: "default" | "failed" | "recording";
}

const action = (
  gesture: IosDockGesture,
  label: string,
  accessibleName = label
): IosDockAction => ({ accessibleName, gesture, label });

const OUTCOME_LABEL: Record<
  NonNullable<IosWorkspaceSnapshot["assessment"]>["outcome"],
  string
> = {
  blocked: "Blocked",
  inconclusive: "Inconclusive",
  "not-working": "Not working",
  working: "Working",
};

const DECIDED = new Set(["dry-run-passed", "dry-run-failed", "verified"]);

const quiet = (
  badge: string,
  nextStep: string,
  tone: IosDockPresentation["tone"] = "default"
): IosDockPresentation => ({
  action: null,
  badge,
  nextStep,
  rejectable: false,
  showsComment: false,
  tone,
});

const teachingPresentation = (
  session: IosWorkspaceSnapshot
): IosDockPresentation => {
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
  const base: IosDockPresentation = {
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
            nextStep:
              "The agent is preparing the simulator. Start recording appears when it hands you control; nothing is captured before then.",
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
          "Do the journey once by tapping the simulator screen. Press stop on the screen that proves it worked.",
        showsComment: true,
      };
    }
    case "ready": {
      return {
        ...base,
        nextStep:
          "Ask an agent to learn this recording. A new recording needs a new iOS session.",
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
        nextStep: "The Flow is running in its own iOS Dry Run.",
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
        nextStep: `${captureState.error} Start a new iOS session to record again.`,
      };
    }
    default: {
      return base;
    }
  }
};

const controlPresentation = (
  session: IosWorkspaceSnapshot
): IosDockPresentation => {
  const badge = KIND_LABEL[session.kind];
  if (session.controller === "user") {
    return {
      ...quiet(
        `${badge} · You have control`,
        session.kind === "dry-run"
          ? "This Dry Run cannot pass after Takeover. Return control when you are done."
          : "Return control when you are done."
      ),
      action: action("return-control", "Return control"),
    };
  }
  return {
    ...quiet(
      badge,
      "The agent is driving the simulator. Take control to act yourself."
    ),
    action: action("take-control", "Take control"),
  };
};

/**
 * How the iOS dock presents one session: a state badge, one sentence on what
 * happens next, and at most one primary action. A terminal phase wins over
 * the capture state, so a closed session never reads as ready. The one
 * exception is a decided recording: Verify flow and Retry cleanup outlive the
 * session that reached them, as they do on Android.
 */
export const iosDockPresentation = (
  session: IosWorkspaceSnapshot
): IosDockPresentation => {
  if (session.captureState !== null && DECIDED.has(session.captureState._tag)) {
    return teachingPresentation(session);
  }
  switch (session.phase) {
    case "pending": {
      if (session.preparation.pending.length > 0) {
        return quiet(
          "Decision needed",
          "Answer the request above before the simulator is prepared."
        );
      }
      return {
        ...quiet(
          "Not prepared",
          `Prepare ${session.selection.device.name} to mirror it here. Nothing is captured until you start recording.`
        ),
        action: action(
          "prepare",
          "Prepare simulator",
          "Prepare selected simulator"
        ),
      };
    }
    case "paused": {
      if (session.refusal?.recovery === "return-to-target-app") {
        return {
          ...quiet(
            "Paused",
            "Another app is in front of the Target App, so nothing was sent. Return to it to carry on.",
            "failed"
          ),
          action: action("return-to-target-app", "Return to Target App"),
        };
      }
      return {
        ...quiet(
          "Paused",
          session.error ??
            "The simulator stopped mirroring. Recover the same simulator to carry on.",
          "failed"
        ),
        action: action("recover", "Recover selected simulator"),
      };
    }
    case "refused": {
      return quiet(
        "Refused",
        session.error ??
          "The request was refused, so this session never used the simulator.",
        "failed"
      );
    }
    case "closed": {
      return quiet(
        "Closed",
        "This session released its simulator. Start a new iOS session to record or run again."
      );
    }
    case "completed": {
      const { assessment } = session;
      return quiet(
        assessment === null ? "Completed" : OUTCOME_LABEL[assessment.outcome],
        assessment?.explanation ?? "The Run Summary is beside the simulator.",
        assessment === null || assessment.outcome === "working"
          ? "default"
          : "failed"
      );
    }
    default: {
      return session.kind === "teaching"
        ? teachingPresentation(session)
        : controlPresentation(session);
    }
  }
};
