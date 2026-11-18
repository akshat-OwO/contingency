import type {
  NativeOrientation,
  PlatformCapability,
} from "@contingency/protocol";
import type { Effect, Redacted, Scope } from "effect";

import type { NativeScreenRecorder } from "./native-screen-recorder.ts";
import type {
  NativeSystemKey,
  PlatformObservation,
  PlatformRuntimeError,
  PlatformRuntimeService,
  PlatformAction,
  PlatformFillResult,
} from "./platform-runtime.ts";

export type NativeAppPlatform = "android" | "ios";

export interface NativeAppRuntimeStartInput<Device = unknown> {
  readonly platform: NativeAppPlatform;
  readonly device: Device;
  readonly targetApp: string;
  readonly requiredCapabilities: readonly PlatformCapability[];
  readonly scope: Scope.Scope;
}

export interface NativeAppVariableFillRequest {
  readonly target: string;
  readonly variable: string;
  readonly value: Effect.Effect<
    Redacted.Redacted<string>,
    PlatformRuntimeError
  >;
}

export interface NativeAppVariableFillResult {
  readonly outcome: "entered";
  readonly confirmation: "confirmed" | "unconfirmed";
  readonly variable: string;
}

export interface NativeAppRuntimeState {
  readonly phase: "ready" | "paused" | "closed";
  readonly observationId: string | null;
  readonly outcome: "none" | "observed" | "uncertain";
  readonly failure: PlatformRuntimeError | null;
}

export interface NativeAppRuntime<
  Observation extends PlatformObservation = PlatformObservation,
  Device = unknown,
> extends PlatformRuntimeService {
  readonly platform: NativeAppPlatform;
  readonly device: Device;
  readonly backendSessionId: string;
  readonly observe: () => Effect.Effect<Observation, PlatformRuntimeError>;
  readonly state: () => NativeAppRuntimeState;
  /** Presses one of the device's own navigation keys. */
  readonly systemKey: (
    observationId: string,
    key: NativeSystemKey
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly recover: () => Effect.Effect<Observation, PlatformRuntimeError>;
  /**
   * Turns the device through the runtime, on a platform whose rotation needs
   * its session (ADR 0082). It needs no observation and works while paused,
   * so a session's end can turn the device back.
   */
  readonly rotate: (
    orientation: NativeOrientation
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly enterVariable: (
    observationId: string,
    request: NativeAppVariableFillRequest
  ) => Effect.Effect<NativeAppVariableFillResult, PlatformRuntimeError>;
  /** The device's own screen recorder, when the platform has one. */
  readonly screenRecorder?: NativeScreenRecorder | undefined;
}

/** Platform modules supply evaluated operations and their target safety policy. */
export interface NativeAppRuntimeBackend<
  Observation extends PlatformObservation,
> {
  readonly sessionId: string;
  readonly validate: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly recover: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly capture: () => Effect.Effect<Observation, PlatformRuntimeError>;
  /**
   * Checks after every capture that the screen it shows can be seen. A secure
   * window can open inside the foreground app between two environment checks,
   * so this runs on every observation, not on the validation cadence.
   */
  readonly requireVisibleScreen?: () => Effect.Effect<
    void,
    PlatformRuntimeError
  >;
  readonly activate: (
    target: string
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly fill: (
    target: string,
    text: string
  ) => Effect.Effect<PlatformFillResult, PlatformRuntimeError>;
  readonly systemKey?: (
    key: NativeSystemKey
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly rotate?: (
    orientation: NativeOrientation
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly close: () => Effect.Effect<void, PlatformRuntimeError>;
  /**
   * Records the device's screen. It runs beside the runtime's input and
   * observations, so a recorder failure never pauses the session.
   */
  readonly screenRecorder?: NativeScreenRecorder | undefined;
}

export interface NativeAppActionPolicy<
  Observation extends PlatformObservation,
> {
  readonly publicAction: (
    observation: Observation,
    action: PlatformAction | { readonly type: NativeSystemKey }
  ) => Effect.Effect<void, PlatformRuntimeError>;
  readonly unconfirmedFill?: (
    observation: Observation,
    target: string
  ) => boolean;
}
