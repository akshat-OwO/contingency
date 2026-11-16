import {
  isLiveAgentSessionPhase,
  profileViewport,
} from "@contingency/protocol";
import type {
  AgentSessionSnapshot,
  AndroidWorkspaceSummary,
  DraftEmulation,
  IosWorkspaceSummary,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";

import { agentSessionLabel } from "@/components/agent/agent-workspace-state";

import { androidSessionLabel } from "./android-dock-state";
import { iosSessionLabel } from "./ios-dock-state";

/** The platforms a session can run on, in the order the home offers them. */
export type HomePlatform = "web" | "android" | "ios";

/** How a session in progress reads on its chip. None of them pulse. */
export type HomeSessionStatus =
  | { readonly _tag: "recording"; readonly startedAt: string }
  | {
      readonly _tag: "running";
      readonly step: readonly [number, number] | undefined;
    }
  | { readonly _tag: "needs-you" }
  | { readonly _tag: "ready" };

/** One card on the In progress shelf, whatever platform it runs on. */
export interface HomeSession {
  readonly id: string;
  readonly platform: HomePlatform;
  /** The accessible name: the same label the dock's session picker uses. */
  readonly label: string;
  readonly title: string;
  readonly activity: string;
  readonly status: HomeSessionStatus;
}

const PLATFORM_NAME: Record<HomePlatform, string> = {
  android: "Android",
  ios: "iOS",
  web: "Web",
};

export const homePlatformName = (platform: HomePlatform): string =>
  PLATFORM_NAME[platform];

/** The Flow name a label leads with, and the activity after it. */
const splitLabel = (label: string) => {
  const separator = label.lastIndexOf(" · ");
  return separator === -1
    ? { activity: undefined, title: label }
    : {
        activity: label.slice(separator + 3),
        title: label.slice(0, separator),
      };
};

// Agent-held setup asks for Variables without adding a pending decision, as
// the dock's Setup Variables tier shows.
const waitsOnSetupVariable = (session: AgentSessionSnapshot) =>
  session.activity === "teaching" &&
  session.controller === "agent" &&
  session.captureState._tag === "setup" &&
  (session.setupVariables ?? []).some(({ status }) => status === "requested");

const webStatus = (session: AgentSessionSnapshot): HomeSessionStatus => {
  if (
    session.pendingDecisions.length > 0 ||
    session.takeover !== null ||
    (session.boundary !== undefined && session.boundary !== null) ||
    waitsOnSetupVariable(session)
  ) {
    return { _tag: "needs-you" };
  }
  if (session.activity === "teaching") {
    return session.captureState._tag === "recording"
      ? { _tag: "recording", startedAt: session.captureState.startedAt }
      : { _tag: "ready" };
  }
  if (!isLiveAgentSessionPhase(session.phase)) {
    return { _tag: "ready" };
  }
  const { run } = session;
  const step =
    run !== null && "activeStepIndex" in run && run.activeStepIndex !== null
      ? ([run.activeStepIndex + 1, run.steps.length] as const)
      : undefined;
  return { _tag: "running", step };
};

/** A browser Agent Session as the shelf shows it. */
export const webHomeSession = (session: AgentSessionSnapshot): HomeSession => {
  const label = agentSessionLabel(session);
  const { activity, title } = splitLabel(label);
  return {
    activity: activity ?? "Teaching",
    id: session.id,
    label,
    platform: "web",
    status: webStatus(session),
    title,
  };
};

const NATIVE_ACTIVITY: Record<AndroidWorkspaceSummary["kind"], string> = {
  "dry-run": "Dry Run",
  run: "Run",
  teaching: "Teaching",
};

/**
 * A native session's list entry carries its phase but not its capture
 * state, so a Teaching session reads Ready until it is opened.
 */
const nativeStatus = (
  session: Pick<AndroidWorkspaceSummary, "kind" | "phase">
): HomeSessionStatus => {
  if (session.phase === "paused") {
    return { _tag: "needs-you" };
  }
  if (
    session.kind !== "teaching" &&
    (session.phase === "running" || session.phase === "pending")
  ) {
    return { _tag: "running", step: undefined };
  }
  return { _tag: "ready" };
};

export const androidHomeSession = (
  session: AndroidWorkspaceSummary
): HomeSession => ({
  activity: NATIVE_ACTIVITY[session.kind],
  id: session.id,
  label: androidSessionLabel(session),
  platform: "android",
  status: nativeStatus(session),
  title: session.flowName,
});

export const iosHomeSession = (session: IosWorkspaceSummary): HomeSession => ({
  activity: NATIVE_ACTIVITY[session.kind],
  id: session.id,
  label: iosSessionLabel(session),
  platform: "ios",
  status: nativeStatus(session),
  title: session.flowName,
});

/** What a session has been recording for, as `mm:ss`. */
export const elapsedClock = (startedAt: string, now: number): string => {
  const seconds = Math.max(
    0,
    Math.floor((now - Date.parse(startedAt)) / 1000) || 0
  );
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * A Viewport the Web start card offers. A phone or tablet brings its own
 * Chromium identity, so the session is that device rather than a narrow
 * desktop window (ADR 0013). iPhone identities are not offered: Chromium can
 * wear their string but not their engine (ADR 0016).
 */
export interface WebViewportPreset {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly viewport: Viewport;
  readonly userAgentProfile: UserAgentProfileId | undefined;
}

const DESKTOP_VIEWPORT: Viewport = {
  deviceScaleFactor: 1,
  height: 800,
  width: 1280,
};

const profilePreset = (
  id: string,
  label: string,
  userAgentProfile: UserAgentProfileId
): WebViewportPreset => {
  const viewport = profileViewport(userAgentProfile) ?? DESKTOP_VIEWPORT;
  return {
    id,
    label,
    note: `${viewport.width} × ${viewport.height}`,
    userAgentProfile,
    viewport,
  };
};

export const webViewportPresets: readonly WebViewportPreset[] = [
  {
    id: "desktop",
    label: "Desktop",
    note: "1280 × 800",
    userAgentProfile: undefined,
    viewport: DESKTOP_VIEWPORT,
  },
  profilePreset("android-phone", "Android phone", "chrome-android-mobile"),
  profilePreset("android-tablet", "Android tablet", "chrome-android-tablet"),
];

export const DEFAULT_WEB_VIEWPORT = "desktop";

/** What the Web start card asks the server to open. */
export interface WebSessionStart {
  readonly name: string;
  readonly url: string | undefined;
  readonly viewport: Viewport;
  readonly emulation: DraftEmulation | undefined;
}

const startingUrl = (startingPage: string): string | undefined => {
  const trimmed = startingPage.trim();
  if (trimmed === "") {
    return undefined;
  }
  return /^[a-z][\w+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * The start request for a preset. A preset with an identity sends the whole
 * Emulation, whose viewport is the session's viewport; the desktop sends
 * only its viewport and runs the default identity.
 */
export const webSessionStart = (
  name: string,
  presetId: string,
  startingPage: string
): WebSessionStart => {
  const preset =
    webViewportPresets.find(({ id }) => id === presetId) ??
    webViewportPresets[0];
  const viewport = preset?.viewport ?? DESKTOP_VIEWPORT;
  const profile = preset?.userAgentProfile;
  return {
    emulation:
      profile === undefined
        ? undefined
        : { permissions: [], userAgentProfile: profile, viewport },
    name: name.trim(),
    url: startingUrl(startingPage),
    viewport,
  };
};
