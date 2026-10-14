/**
 * How an Android session reads in the Workspace dock, on the browser dock's
 * own state names and gestures. Prototype code for #479.
 */
import type {
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";

import { teachingRecordingPresentation } from "@/components/agent/teaching-recording-state";
import type { SkillsSessionView } from "@/components/catalog/skills-drawer-state";

const KIND_LABEL: Record<AndroidWorkspaceSummary["kind"], string> = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
};

/**
 * An Android session reads like a browser one in the session picker: the Flow
 * Skill name first, then what the session is doing with it, marked Android so
 * the two platforms never share a label.
 */
export const androidSessionLabel = (session: AndroidWorkspaceSummary): string =>
  `${session.flowSkillName} · Android ${KIND_LABEL[session.kind]}`;

/** What the Skills drawer needs to know about an Android session. */
export const androidSkillsSessionView = (
  session: AndroidWorkspaceSnapshot
): SkillsSessionView =>
  session.kind === "teaching"
    ? {
        activity: "teaching",
        captureState: session.captureState?._tag ?? "setup",
        flowSkillName: session.flowSkillName,
      }
    : {
        activity: "run",
        dryRun: session.kind === "dry-run",
        flowSkillNames: [session.flowSkillName],
      };

/** Whether the session still owns its emulator. */
export const isLiveAndroidSession = (
  session: AndroidWorkspaceSummary
): boolean =>
  session.phase === "pending" ||
  session.phase === "running" ||
  session.phase === "paused";

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
  readonly tone: "default" | "failed" | "recording";
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

/**
 * The Teaching states, on the browser's own names and gestures. The sentences
 * that name the browser are said about the emulator instead; the rest are
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
            nextStep:
              "The agent is preparing the emulator. Start recording appears when it hands you control; nothing is captured before then.",
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
          "Do the journey once on the device. Press stop on the screen that proves it worked.",
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
        nextStep: "The flow skill appears in Skills when it is drafted.",
      };
    }
    case "dry-running": {
      return {
        ...base,
        nextStep: "The flow skill is running in its own Android Dry Run.",
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
  const badge = KIND_LABEL[session.kind];
  if (session.controller === "user") {
    return {
      ...quiet(
        `${badge} · You have control`,
        session.kind === "dry-run"
          ? "You hold the emulator. This Dry Run cannot pass after Takeover; return control when you are done."
          : "You hold the emulator. Return control when you are done."
      ),
      action: action("return-control", "Return control"),
    };
  }
  return {
    ...quiet(
      badge,
      "The agent is driving the emulator. Take control to act yourself."
    ),
    action: action("take-control", "Take control"),
  };
};

/**
 * How the Android dock presents one session. It mirrors the browser dock: a
 * state badge, one sentence on what happens next, and at most one primary
 * action. Android adds only what a device needs first: preparing the
 * emulator, the Run Environment Permission, and recovering the same emulator
 * after a pause.
 */
export const androidDockPresentation = (
  session: AndroidWorkspaceSnapshot
): AndroidDockPresentation => {
  // Verification and Cleanup stay reachable after the session ends.
  if (session.captureState !== null && DECIDED.has(session.captureState._tag)) {
    return teachingPresentation(session);
  }
  switch (session.phase) {
    case "pending": {
      if (session.preparation.pending.length > 0) {
        return quiet(
          "Permission needed",
          "Answer the request above before the emulator is prepared."
        );
      }
      return {
        ...quiet(
          "Not prepared",
          `Prepare ${session.selection.device.avd} to mirror it here. Nothing is captured until you start recording.`
        ),
        action: action(
          "prepare",
          "Prepare emulator",
          "Prepare selected emulator"
        ),
      };
    }
    case "paused": {
      return {
        ...quiet(
          "Paused",
          session.error ??
            "The emulator disconnected or this session lost ownership. Recover the same emulator to carry on.",
          "failed"
        ),
        action: action("recover", "Recover same emulator"),
      };
    }
    case "refused": {
      return quiet(
        "Refused",
        session.error ??
          "The Run Environment Permission was refused, so this session never used the emulator.",
        "failed"
      );
    }
    case "closed": {
      return quiet("Closed", "This session released its emulator.");
    }
    case "completed": {
      const { assessment } = session;
      return quiet(
        assessment === null ? "Completed" : OUTCOME_LABEL[assessment.outcome],
        assessment?.explanation ?? "The Run Summary is beside the device.",
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

/**
 * The semantic elements a user can act on. Password and covered nodes are
 * never offered, and a non-editable node is offered only when the session
 * declared it reversible.
 */
export const actionableNodes = (
  session: AndroidWorkspaceSnapshot
): NonNullable<AndroidWorkspaceSnapshot["observation"]>["nodes"] => {
  const declared =
    session.requirements.platform === "android"
      ? (session.requirements.reversibleActions ?? [])
      : [];
  return (session.observation?.nodes ?? []).filter(
    (node) =>
      !node.password &&
      !node.covered &&
      (node.editable ||
        declared.some(
          (allowed) => allowed.role === node.role && allowed.name === node.name
        ))
  );
};
