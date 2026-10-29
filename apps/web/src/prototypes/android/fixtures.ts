/**
 * Recorded Android Workspace data for the #479 prototypes. Every snapshot has
 * the shipped protocol's shape, and every command moves it the way the
 * service would, so a prototype can be clicked through without an emulator.
 * The screens are captures of the checkout fixture on Pixel_9.
 *
 * Prototype code only: delete `src/prototypes/android` and its route to
 * remove it.
 */
import { AgentSessionId, FlowSkillName } from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSnapshot,
  AndroidWorkspaceSummary,
} from "@contingency/protocol";

import cartScreen from "./screens/cart.png?inline";
import catalogScreen from "./screens/catalog.png?inline";
import confirmedScreen from "./screens/confirmed.png?inline";
import signinFilledScreen from "./screens/signin-filled.png?inline";
import signinScreen from "./screens/signin.png?inline";

export const PROTOTYPE_STATES = [
  "select",
  "teaching",
  "agent-run",
  "permission",
  "paused",
  "dry-run-passed",
  "verified",
] as const;
export type PrototypeState = (typeof PROTOTYPE_STATES)[number];

export const PROTOTYPE_VARIANTS = [
  "direct",
  "agent-led",
  "dock-switch",
  "picker-sheet",
] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

export const STATE_LABEL: Record<PrototypeState, string> = {
  "agent-run": "Agent-controlled Run",
  "dry-run-passed": "Dry Run passed",
  paused: "Disconnect pause",
  permission: "Run Environment Permission",
  select: "Select device and Target App",
  teaching: "Teaching",
  verified: "Verified with Cleanup",
};

const AT = "2026-10-13T14:00:00.000Z";
const base64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

interface Screen {
  readonly image: string;
  readonly nodes: NonNullable<AndroidWorkspaceSnapshot["observation"]>["nodes"];
}

const node = (
  role: string,
  name: string,
  editable = false
): Screen["nodes"][number] => ({
  covered: false,
  editable,
  name,
  password: false,
  role,
  target: `${role}:${name}`,
});

/**
 * Where each element sits on its capture, in the capture's own pixels. The
 * backend already reads these from agent-device (`rect`); the protocol does
 * not carry them yet. Tapping the mirror needs exactly this one addition.
 */
export interface Bounds {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

const FULL_WIDTH = { width: 353, x: 24 };
export const BOUNDS: ReadonlyMap<string, Bounds> = new Map(
  Object.entries({
    "button:Add Anvil to cart": { ...FULL_WIDTH, height: 46, y: 177 },
    "button:Open cart": { ...FULL_WIDTH, height: 46, y: 273 },
    "button:Place mock order": { ...FULL_WIDTH, height: 46, y: 145 },
    "button:Sign in": { ...FULL_WIDTH, height: 46, y: 207 },
    "group:Cart": { height: 34, width: 60, x: 24, y: 62 },
    "group:Catalog": { height: 34, width: 90, x: 24, y: 62 },
    "group:Fixture Shop sign in": { height: 34, width: 215, x: 24, y: 62 },
    "group:Order confirmed": { height: 34, width: 190, x: 24, y: 62 },
    "text-field:Fixture Shopper": { ...FULL_WIDTH, height: 46, y: 145 },
    "text-field:Shopper name": { ...FULL_WIDTH, height: 46, y: 145 },
    "text:Anvil × 1": { height: 18, width: 55, x: 24, y: 111 },
    "text:Cart: 0 items": { height: 18, width: 80, x: 24, y: 239 },
    "text:Signed in as Fixture Shopper": {
      height: 18,
      width: 175,
      x: 24,
      y: 111,
    },
  } satisfies Record<string, Bounds>)
);

/** What the agent is acting on in the agent-controlled fixture Run. */
export const AGENT_TARGET = "button:Place mock order";

export const SCREENS = {
  cart: {
    image: base64(cartScreen),
    nodes: [
      node("group", "Cart"),
      node("text", "Anvil × 1"),
      node("button", "Place mock order"),
    ],
  },
  catalog: {
    image: base64(catalogScreen),
    nodes: [
      node("group", "Catalog"),
      node("text", "Signed in as Fixture Shopper"),
      node("button", "Add Anvil to cart"),
      node("text", "Cart: 0 items"),
      node("button", "Open cart"),
    ],
  },
  confirmed: {
    image: base64(confirmedScreen),
    nodes: [node("group", "Order confirmed")],
  },
  signin: {
    image: base64(signinScreen),
    nodes: [
      node("group", "Fixture Shop sign in"),
      node("text-field", "Shopper name", true),
      node("button", "Sign in"),
    ],
  },
  "signin-filled": {
    image: base64(signinFilledScreen),
    nodes: [
      node("group", "Fixture Shop sign in"),
      node("text-field", "Fixture Shopper", true),
      node("button", "Sign in"),
    ],
  },
} satisfies Record<string, Screen>;
export type ScreenName = keyof typeof SCREENS;

/** Which screen an activation leads to, by the activated element's name. */
const NEXT_SCREEN = {
  "Add Anvil to cart": "catalog",
  "Open cart": "cart",
  "Place mock order": "confirmed",
  "Sign in": "catalog",
} as const satisfies Record<string, ScreenName>;

const leadsSomewhere = (name: string): name is keyof typeof NEXT_SCREEN =>
  Object.hasOwn(NEXT_SCREEN, name);

let observationCount = 0;
export const observe = (screen: ScreenName) => {
  observationCount += 1;
  return {
    capturedAt: AT,
    height: 900,
    id: `observation-${observationCount}`,
    image: SCREENS[screen].image,
    nodes: SCREENS[screen].nodes,
    width: 401,
  };
};

const SCREEN_NAMES = [
  "cart",
  "catalog",
  "confirmed",
  "signin",
  "signin-filled",
] as const satisfies readonly ScreenName[];

const screenOf = (snapshot: AndroidWorkspaceSnapshot): ScreenName =>
  SCREEN_NAMES.find(
    (name) => SCREENS[name].image === snapshot.observation?.image
  ) ?? "signin";

export const FIXTURE_SELECTION = {
  device: {
    api: 36,
    avd: "Pixel_9",
    fingerprint:
      "google/sdk_gphone64_arm64/emu64a:16/BE2A.250530.026.D1/13818094:user/release-keys",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.contingency.checkout",
    startingState: "Fresh sign-in screen after an activity restart",
  },
  helperConsent: "none",
  outcomes: [{ name: "Order confirmed", role: "group" }],
  setup: {
    activity: ".MainActivity",
    conditions: [{ name: "Fixture Shop sign in", role: "group" }],
    kind: "restart-activity",
  },
} satisfies AndroidWorkspaceSnapshot["selection"];

/** Emulators a device picker could list. The protocol has no such list yet. */
export const DETECTED_EMULATORS = [
  {
    api: 36,
    avd: "Pixel_9",
    ready: true,
    serial: "emulator-5554",
  },
  {
    api: 36,
    avd: "Medium_Phone_API_36.1",
    ready: false,
    serial: "emulator-5556",
  },
] as const;

/**
 * Third-party apps a Target App picker could list, with the build read from
 * the device. The protocol has no such list yet.
 */
export const INSTALLED_APPS = [
  {
    activity: ".MainActivity",
    appBuild: "1",
    appId: "dev.contingency.checkout",
    label: "Fixture Shop",
  },
  {
    activity: ".ui.MainActivity",
    appBuild: "412",
    appId: "com.example.notes",
    label: "Notes",
  },
  {
    activity: ".LauncherActivity",
    appBuild: "88",
    appId: "com.example.weather",
    label: "Weather",
  },
] as const;

const teaching: AndroidWorkspaceSnapshot = {
  assessment: null,
  captureGaps: [],
  captureState: { _tag: "setup", requestedAt: AT },
  cleanup: null,
  completedAt: null,
  controller: "user",
  error: null,
  field: null,
  flowSkillName: FlowSkillName.make("checkout"),
  id: AgentSessionId.make("agent-android-teaching"),
  kind: "teaching",
  observation: null,
  phase: "pending",
  preparation: { differences: [], evidence: [], pending: [], phase: "pending" },
  recordingId: null,
  requirements: {
    capabilities: ["semantic-actions", "screenshots"],
    environment: FIXTURE_SELECTION.environment,
    outcomes: FIXTURE_SELECTION.outcomes,
    platform: "android",
    preparation: FIXTURE_SELECTION.setup,
  },
  revision: 0,
  selection: FIXTURE_SELECTION,
  startedAt: AT,
  takeoverOccurred: false,
};

const working = {
  explanation:
    "Order confirmed was observed after Place mock order; no payment was taken.",
  observationId: "observation-final",
  outcome: "working",
} as const;

const dryRunResult = {
  completedAt: AT,
  inputs: [{ changed: true, name: "shopper", value: "Second Shopper" }],
  observableOutcome: "Order confirmed",
  outcome: "passed",
} as const;

const passedCapture = {
  _tag: "dry-run-passed",
  draftedAt: AT,
  dryRunEndedAt: AT,
  dryRunResult,
  dryRunSessionId: AgentSessionId.make("agent-android-dry-run"),
  dryRunStartedAt: AT,
  readyAt: AT,
  skillPath: "checkout/SKILL.md",
  startedAt: AT,
  stoppedAt: AT,
} as const;

const evidence = [
  { type: "preflight" },
  { type: "setup" },
  { observationId: "observation-final", type: "observation" },
  { type: "closed" },
];

/** The session each prototype state opens on, or `null` before one exists. */
export const fixtureSnapshot = (
  state: PrototypeState
): AndroidWorkspaceSnapshot | null => {
  switch (state) {
    case "select": {
      return null;
    }
    case "teaching": {
      return {
        ...teaching,
        captureState: {
          _tag: "recording",
          startedAt: new Date(Date.now() - 42_000).toISOString(),
        },
        observation: observe("catalog"),
        phase: "running",
        preparation: { ...teaching.preparation, phase: "ready" },
        recordingId: null,
      };
    }
    case "agent-run": {
      return {
        ...teaching,
        captureState: null,
        controller: "agent",
        id: AgentSessionId.make("agent-android-run"),
        kind: "run",
        observation: observe("cart"),
        phase: "running",
        preparation: { ...teaching.preparation, phase: "ready" },
      };
    }
    case "permission": {
      return {
        ...teaching,
        captureState: null,
        controller: "agent",
        id: AgentSessionId.make("agent-android-changed"),
        kind: "run",
        preparation: {
          ...teaching.preparation,
          differences: [{ field: "appBuild", selected: "2", taught: "1" }],
          pending: [
            {
              id: "decision-changed-build",
              kind: "run-environment-permission",
              targetApp: "dev.contingency.checkout",
            },
          ],
        },
        selection: {
          ...FIXTURE_SELECTION,
          environment: { ...FIXTURE_SELECTION.environment, appBuild: "2" },
        },
      };
    }
    case "paused": {
      return {
        ...teaching,
        captureState: null,
        controller: "agent",
        error:
          "The selected Android device is disconnected. Execution is paused; dispatched input may have an uncertain outcome.",
        id: AgentSessionId.make("agent-android-run"),
        kind: "run",
        observation: observe("cart"),
        phase: "paused",
        preparation: { ...teaching.preparation, phase: "paused" },
      };
    }
    case "dry-run-passed": {
      return {
        ...teaching,
        assessment: working,
        captureState: passedCapture,
        completedAt: AT,
        controller: "agent",
        id: AgentSessionId.make("agent-android-dry-run"),
        kind: "dry-run",
        observation: observe("confirmed"),
        phase: "completed",
        preparation: { ...teaching.preparation, evidence, phase: "closed" },
        recordingId: null,
      };
    }
    default: {
      const passed = fixtureSnapshot("dry-run-passed");
      return passed === null
        ? null
        : {
            ...passed,
            captureState: {
              ...passedCapture,
              _tag: "verified",
              verifiedAt: AT,
            },
            cleanup: { _tag: "purged", completedAt: AT },
          };
    }
  }
};

/** Other sessions the session picker lists beside the selected one. */
export const fixtureSessions = (): readonly AndroidWorkspaceSummary[] =>
  (["teaching", "agent-run", "permission", "dry-run-passed"] as const).flatMap(
    (state) => {
      const snapshot = fixtureSnapshot(state);
      return snapshot === null ? [] : [snapshot];
    }
  );

type InputAction = Extract<
  AndroidWorkspaceCommand,
  { readonly _tag: "input" }
>["action"];

/** The screen a semantic action leads to on the checkout fixture. */
const inputResult = (
  current: AndroidWorkspaceSnapshot,
  action: InputAction
) => {
  if (action._tag === "back") {
    return observe("signin");
  }
  if (action._tag === "fill") {
    return observe("signin-filled");
  }
  const target = current.observation?.nodes.find(
    (entry) => entry.target === action.target
  );
  return observe(
    target !== undefined && leadsSomewhere(target.name)
      ? NEXT_SCREEN[target.name]
      : screenOf(current)
  );
};

/** Verify keeps the skill and purges the recording; reject keeps both. */
const flowDecision = (
  current: AndroidWorkspaceSnapshot,
  decision: "verify" | "reject" | "retry-cleanup",
  next: (patch: Partial<AndroidWorkspaceSnapshot>) => AndroidWorkspaceSnapshot
) => {
  if (current.captureState?._tag !== "dry-run-passed") {
    return next({});
  }
  return decision === "reject"
    ? next({ phase: "closed" })
    : next({
        captureState: {
          ...current.captureState,
          _tag: "verified",
          verifiedAt: AT,
        },
        cleanup: { _tag: "purged", completedAt: AT },
      });
};

/** What the service would answer to one command, without a device. */
export const applyCommand = (
  current: AndroidWorkspaceSnapshot | null,
  command: AndroidWorkspaceCommand
): AndroidWorkspaceSnapshot | null => {
  if (command._tag === "start") {
    // The service derives a session's requirements from its selection, so
    // the taps a person allowed are the only ones the device offers.
    const { selection } = command;
    return {
      ...teaching,
      flowSkillName: command.flowSkillName,
      kind: command.kind,
      requirements: {
        ...teaching.requirements,
        environment: selection.environment,
        outcomes: selection.outcomes,
        platform: "android",
        preparation: selection.setup,
      },
      selection,
    };
  }
  if (current === null) {
    return null;
  }
  const next = (
    patch: Partial<AndroidWorkspaceSnapshot>
  ): AndroidWorkspaceSnapshot => ({
    ...current,
    ...patch,
    revision: current.revision + 1,
  });
  switch (command._tag) {
    case "prepare":
    case "recover": {
      return next({
        error: null,
        observation: observe(
          command._tag === "recover" ? screenOf(current) : "signin"
        ),
        phase: "running",
        preparation: { ...current.preparation, phase: "ready" },
      });
    }
    case "decide": {
      return command.allow
        ? next({
            preparation: {
              ...current.preparation,
              evidence: [
                ...current.preparation.evidence,
                { decisionId: command.decisionId, type: "grant" },
              ],
              pending: [],
            },
          })
        : next({
            error: "The Run Environment Permission was refused.",
            phase: "refused",
            preparation: {
              ...current.preparation,
              pending: [],
              phase: "refused",
            },
          });
    }
    case "record": {
      return next({
        captureState: command.start
          ? { _tag: "recording", startedAt: new Date().toISOString() }
          : { _tag: "ready", readyAt: AT, startedAt: AT, stoppedAt: AT },
      });
    }
    case "control": {
      return next({
        controller: command.controller,
        takeoverOccurred:
          current.takeoverOccurred || command.controller === "user",
      });
    }
    case "input": {
      return next({ observation: inputResult(current, command.action) });
    }
    case "flow-decision": {
      return flowDecision(current, command.decision, next);
    }
    case "close": {
      return next({ phase: "closed" });
    }
    default: {
      return current;
    }
  }
};
