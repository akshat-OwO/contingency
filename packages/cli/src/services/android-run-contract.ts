import type {
  AndroidPreparation,
  PlatformRequirements,
} from "@contingency/protocol";
import type { Effect } from "effect";

import type {
  AndroidObservation,
  AndroidPlatformRuntime,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import type {
  NativeAppEnvironmentDifference,
  NativeAppRunDecision,
  NativeAppRunEvidence,
  NativeAppRunState,
  NativeAppRun,
} from "./native-app-run-contract.ts";
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
  readonly appInstallation?: { readonly apk: string; readonly sha256: string };
}

export type AndroidEnvironmentDifference = NativeAppEnvironmentDifference<
  keyof AndroidEnvironment
>;
export interface AndroidRunDecision extends NativeAppRunDecision<AndroidEnvironmentDifference> {
  readonly sha256?: string;
  readonly serial?: string;
}
export type AndroidRunEvidence = NativeAppRunEvidence;
export type AndroidRunState = NativeAppRunState<
  AndroidRunInput,
  AndroidRunDecision
>;
export type AndroidRun = NativeAppRun<AndroidObservation, AndroidRunState>;

export interface AndroidRunDriver {
  readonly preflight: (
    input: AndroidRunInput,
    phase?: "installed"
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly start: (
    input: AndroidRunInput
  ) => Effect.Effect<AndroidPlatformRuntime, PlatformRuntimeError>;
}
