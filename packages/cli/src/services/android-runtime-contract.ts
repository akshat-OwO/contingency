import type {
  AndroidElementBounds,
  PlatformCapability,
} from "@contingency/protocol";
import type { Effect } from "effect";

import type { AndroidRun, AndroidRunInput } from "./android-run-contract.ts";
import type {
  NativeAppPrivateTextRequest,
  NativeAppPrivateTextResult,
  NativeAppRuntimeState,
  NativeAppRuntime,
  NativeAppRuntimeStartInput,
  NativeAppRuntimeBackend,
} from "./native-app-runtime-contract.ts";
import type {
  PlatformObservation,
  PlatformRuntimeError,
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

/** Contingency's own helper; it enters private text and nothing else. */
export const androidPrivateTextRelease = {
  instrumentation: "dev.contingency.privatetext/.PrivateText",
  packageName: "dev.contingency.privatetext",
  protocol: "contingency-private-text-v1",
  sha256: "3391ecaff97427952b634419af52ed5b6debc12672b5f14a04eb7ccc5abe7796",
  signingCertificateSha256:
    "f5aad901eaaa4ddc5d529021a435e6f357f32a75dc437f20e5de5eec4612b0de",
  version: "1.0.0",
  versionCode: 1,
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

export interface AndroidPrivateTextGrant {
  readonly serial: string;
  readonly sha256: typeof androidPrivateTextRelease.sha256;
  readonly operation: "install" | "replace" | "auto";
}

export interface AndroidRuntimeStartInput extends NativeAppRuntimeStartInput<AndroidDeviceSelection> {
  readonly platform: "android";
  readonly installationGrant?: AndroidInstallationGrant;
  /** Required with private input when the private text helper is absent or different. */
  readonly privateTextGrant?: AndroidPrivateTextGrant;
}

/** The observed field a private value may enter, as the helper re-resolves it. */
export interface AndroidPrivateTextBinding {
  readonly packageName: string;
  readonly resourceId: string | null;
  readonly className: string;
  readonly bounds: readonly [number, number, number, number];
  readonly password: boolean;
  readonly focusedWindow: string;
}

export type AndroidPrivateTextRequest = NativeAppPrivateTextRequest;

export type AndroidPrivateTextResult = NativeAppPrivateTextResult;

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

export type AndroidRuntimeState = NativeAppRuntimeState;

export interface AndroidPlatformRuntime extends NativeAppRuntime<
  AndroidObservation,
  AndroidDeviceSelection
> {
  readonly platform: "android";
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
export interface AndroidRuntimeBackend extends NativeAppRuntimeBackend<AndroidObservation> {
  readonly back: NonNullable<
    NativeAppRuntimeBackend<AndroidObservation>["back"]
  >;
  readonly enterPrivate: NonNullable<
    NativeAppRuntimeBackend<AndroidObservation>["enterPrivate"]
  >;
}
