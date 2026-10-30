import type { Effect } from "effect";

import type { nativeAppRuntimeError } from "./native-app-error.ts";
import type {
  NativeAppRuntime,
  NativeAppRuntimeStartInput,
} from "./native-app-runtime-contract.ts";
import type {
  PlatformObservation,
  PlatformRuntimeError,
} from "./platform-runtime.ts";

export interface NativeAppRunInput extends NativeAppRuntimeStartInput {
  readonly taught: unknown;
  readonly environment: unknown;
  readonly setup: unknown;
  readonly teaching?: boolean;
}

export interface NativeAppEnvironmentDifference<Field extends string = string> {
  readonly field: Field;
  readonly taught: string;
  readonly selected: string;
}

export interface NativeAppRunDecision<
  Difference extends NativeAppEnvironmentDifference =
    NativeAppEnvironmentDifference,
> {
  readonly id: string;
  readonly runId: string;
  readonly targetApp: string;
  readonly kind: "run-environment-permission" | "app-installation";
  readonly differences: readonly Difference[];
}

export interface NativeAppRunEvidence {
  readonly type:
    | "fill"
    | "preflight"
    | "grant"
    | "refusal"
    | "setup"
    | "observation"
    | "pause"
    | "closed";
  readonly inputConfirmation?: "confirmed" | "unconfirmed";
  readonly observationId?: string;
  readonly decisionId?: string;
  readonly code?: PlatformRuntimeError["code"];
}

export interface NativeAppRunState<
  Input extends NativeAppRunInput,
  Decision extends NativeAppRunDecision,
> {
  readonly runId: string;
  readonly device: Input["device"];
  readonly environment: Input["environment"];
  readonly taught: Input["taught"];
  readonly setup: Input["setup"];
  readonly decisions: readonly Decision[];
  readonly pending: readonly Decision[];
  readonly phase: "pending" | "ready" | "paused" | "refused" | "closed";
  readonly differences: Decision["differences"];
  readonly evidence: readonly NativeAppRunEvidence[];
}

export interface NativeAppRun<Observation extends PlatformObservation, State> {
  readonly mirror: () => Effect.Effect<Observation, PlatformRuntimeError>;
  readonly state: () => State;
  readonly decide: (
    id: string,
    allow: boolean
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly prepare: () => Effect.Effect<Observation, PlatformRuntimeError>;
  readonly observe: NativeAppRuntime<Observation>["observe"];
  readonly dispatch: NativeAppRuntime<Observation>["dispatch"];
  readonly back: NativeAppRuntime<Observation>["back"];
  readonly enterVariable: NativeAppRuntime<Observation>["enterVariable"];
  readonly recover: NativeAppRuntime<Observation>["recover"];
  readonly close: NativeAppRuntime<Observation>["close"];
}

/** Preparation and environment interpretation belong to the platform. */
export interface NativeAppRunDriver<
  Input extends NativeAppRunInput,
  Observation extends PlatformObservation,
  Decision extends NativeAppRunDecision,
> {
  readonly error?: typeof nativeAppRuntimeError;
  readonly validate: (
    input: Input
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly preflight: (
    input: Input,
    phase?: "installed"
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly differences: (input: Input) => Decision["differences"];
  readonly decisions: (
    input: Input,
    runId: string,
    differences: Decision["differences"]
  ) => readonly Decision[];
  readonly authorize: (input: Input) => Input;
  readonly start: (
    input: Input
  ) => Effect.Effect<NativeAppRuntime<Observation>, PlatformRuntimeError>;
  readonly startingConditions: (
    input: Input,
    observation: Observation
  ) => boolean;
}
