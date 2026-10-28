import type {
  AndroidElementBounds,
  PlatformCapability,
} from "@contingency/protocol";
import type { Effect, Redacted, Scope } from "effect";

import type { AndroidRun, AndroidRunInput } from "./android-run-contract.ts";
import type {
  PlatformFillResult,
  PlatformObservation,
  PlatformRuntimeError,
  PlatformRuntimeService,
} from "./platform-runtime.ts";

export const androidCapabilities: readonly PlatformCapability[] = [
  "semantic-actions",
  "screenshots",
  "private-input",
];

export const androidHelperRelease = {
  api: "2",
  packageName: "com.callstack.agentdevice.snapshothelper",
  sha256: "79175080eb71f444224c844a599e75e839d6456790eb96d175fc887f85237a12",
  signingCertificateSha256:
    "f5dc3a7bf83a1b17312c222cd89a2f781230f34a7a407e6033fa28adf0b3cf48",
  version: "0.21.25",
  versionCode: 21_025,
} as const;

/** A selection is supplied by the user, never inferred from device count. */
export type AndroidDeviceSelection = {
  readonly host: "local";
  readonly serial: string;
  /** Within the Support Matrix range; startup refuses any other level. */
  readonly api: number;
  readonly fingerprint: string;
} & (
  | { readonly kind?: "emulator"; readonly avd: string }
  | { readonly kind: "physical"; readonly model: string }
);

export interface AndroidInstallationGrant {
  readonly serial: string;
  readonly sha256: typeof androidHelperRelease.sha256;
  readonly operation: "install" | "replace" | "auto";
}

export interface AndroidRuntimeStartInput {
  readonly platform: "android";
  readonly device: AndroidDeviceSelection;
  readonly targetApp: string;
  readonly requiredCapabilities: readonly PlatformCapability[];
  readonly installationGrant?: AndroidInstallationGrant;
  readonly scope: Scope.Scope;
}

export interface AndroidVariableFillRequest {
  readonly target: string;
  /** The Variable reference recorded with the fill. */
  readonly variable: string;
  /** Resolved when dispatching the ordinary fill. */
  readonly value: Effect.Effect<
    Redacted.Redacted<string>,
    PlatformRuntimeError
  >;
}

export interface AndroidVariableFillResult {
  readonly outcome: "entered";
  readonly confirmation: "confirmed" | "unconfirmed";
  readonly variable: string;
}

export interface AndroidObservation extends PlatformObservation {
  readonly platform: "android";
  readonly device: AndroidDeviceSelection;
  readonly backendSessionId: string;
  readonly generation: number;
  readonly ownership: {
    readonly kind: "experimental-host-check";
    readonly focusedPackage: string;
    readonly systemDialogAuthority: "unsupported";
  };
  readonly capture: {
    readonly mode: "interactive-windows";
    readonly complete: true;
    readonly windowCount: number;
    readonly secureWindowVisibility: "unverified";
  };
  readonly nodes: readonly {
    readonly target: string;
    readonly role: string;
    readonly name: string;
    readonly packageName: string | null;
    readonly editable: boolean;
    readonly hittable: boolean;
    readonly password: boolean;
    readonly covered: boolean;
    readonly bounds?: AndroidElementBounds;
  }[];
}

export interface AndroidRuntimeState {
  readonly phase: "ready" | "paused" | "closed";
  readonly observationId: string | null;
  readonly outcome: "none" | "observed" | "uncertain";
  readonly failure: PlatformRuntimeError | null;
}

/** Android has no browser session, URL, tab, or Emulation. */
export interface AndroidPlatformRuntime extends PlatformRuntimeService {
  readonly platform: "android";
  readonly device: AndroidDeviceSelection;
  readonly backendSessionId: string;
  readonly observe: () => Effect.Effect<
    AndroidObservation,
    PlatformRuntimeError
  >;
  readonly state: () => AndroidRuntimeState;
  readonly back: (
    observationId: string
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly recover: () => Effect.Effect<
    AndroidObservation,
    PlatformRuntimeError
  >;
  /** Enters a Variable through the ordinary stock agent-device fill path. */
  readonly enterVariable: (
    observationId: string,
    request: AndroidVariableFillRequest
  ) => Effect.Effect<AndroidVariableFillResult, PlatformRuntimeError>;
}

export interface AndroidRuntimeFactoryService {
  readonly createRun: (
    input: AndroidRunInput
  ) => Effect.Effect<AndroidRun, PlatformRuntimeError>;
  readonly platform: "android";
  readonly capabilities: readonly PlatformCapability[];
  readonly start: (
    input: AndroidRuntimeStartInput
  ) => Effect.Effect<AndroidPlatformRuntime, PlatformRuntimeError>;
}

/** Only evaluated operations are available to the adapter. */
export interface AndroidRuntimeBackend {
  readonly sessionId: string;
  readonly validate: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly recover: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly capture: () => Effect.Effect<
    AndroidObservation,
    PlatformRuntimeError
  >;
  readonly activate: (
    target: string
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly fill: (
    target: string,
    text: string
  ) => Effect.Effect<PlatformFillResult, PlatformRuntimeError>;
  readonly back: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly close: () => Effect.Effect<void, PlatformRuntimeError>;
}
