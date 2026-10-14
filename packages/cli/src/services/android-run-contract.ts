import type {
  AndroidPreparation,
  PlatformRequirements,
} from "@contingency/protocol";
import type { Effect } from "effect";

import type {
  AndroidDeviceSelection,
  AndroidObservation,
  AndroidPlatformRuntime,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

export type AndroidEnvironment = Extract<
  PlatformRequirements,
  { platform: "android" }
>["environment"];

/** The only supported fresh-state recipe. No arbitrary shell, reset, or snapshot route. */
export type AndroidSetup = AndroidPreparation;

export interface AndroidRunInput extends AndroidRuntimeStartInput {
  readonly taught: PlatformRequirements;
  readonly environment: AndroidEnvironment;
  readonly setup: AndroidSetup;
  /** Only these declared reversible activations are exposed; Confirmation is unavailable. */
  readonly reversibleActions?: readonly {
    readonly role: string;
    readonly name: string;
  }[];
  readonly clearDataGrant?: {
    readonly serial: string;
    readonly targetApp: string;
  };
  readonly appInstallation?: { readonly apk: string; readonly sha256: string };
}

export interface AndroidEnvironmentDifference {
  readonly field: keyof AndroidEnvironment;
  readonly taught: string;
  readonly selected: string;
}

export interface AndroidRunDecision {
  readonly id: string;
  readonly runId: string;
  readonly targetApp: string;
  readonly kind:
    | "run-environment-permission"
    | "app-installation"
    | "clear-app-data";
  readonly differences: readonly AndroidEnvironmentDifference[];
  readonly sha256?: string;
  readonly serial?: string;
}

export interface AndroidRunEvidence {
  readonly type:
    | "preflight"
    | "grant"
    | "refusal"
    | "setup"
    | "observation"
    | "pause"
    | "closed";
  readonly observationId?: string;
  readonly decisionId?: string;
  readonly code?: PlatformRuntimeError["code"];
}

export interface AndroidRunState {
  readonly runId: string;
  readonly device: AndroidDeviceSelection;
  readonly environment: AndroidEnvironment;
  readonly taught: PlatformRequirements;
  readonly decisions: readonly AndroidRunDecision[];
  readonly setup: AndroidSetup;
  readonly phase: "pending" | "ready" | "paused" | "refused" | "closed";
  readonly differences: readonly AndroidEnvironmentDifference[];
  readonly pending: readonly AndroidRunDecision[];
  readonly evidence: readonly AndroidRunEvidence[];
}

/** Workspace gets decisions and sanitized evidence; no runtime handle bypasses preparation. */
export interface AndroidRun {
  /** Display capture updates the current observation without retaining every idle frame as Run evidence. */
  readonly mirror: AndroidPlatformRuntime["observe"];
  readonly state: () => AndroidRunState;
  readonly decide: (
    id: string,
    allow: boolean
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly prepare: () => Effect.Effect<
    AndroidObservation,
    PlatformRuntimeError
  >;
  readonly observe: AndroidPlatformRuntime["observe"];
  readonly dispatch: AndroidPlatformRuntime["dispatch"];
  readonly back: AndroidPlatformRuntime["back"];
  readonly recover: AndroidPlatformRuntime["recover"];
  readonly close: AndroidPlatformRuntime["close"];
}

export interface AndroidRunDriver {
  readonly preflight: (
    input: AndroidRunInput,
    phase?: "installed"
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly start: (
    input: AndroidRunInput
  ) => Effect.Effect<AndroidPlatformRuntime, PlatformRuntimeError>;
}
