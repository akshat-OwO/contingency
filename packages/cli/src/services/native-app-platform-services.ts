import type { Effect, Scope } from "effect";

import type { NativeAppPlatform } from "./native-app-runtime-contract.ts";

/** Discovery and disposable preparation remain typed platform capabilities. */
export interface NativeAppPlatformServices<Device, App, Input, Session, Error> {
  readonly platform: NativeAppPlatform;
  readonly discovery: {
    readonly devices: () => Effect.Effect<readonly Device[], Error>;
    readonly apps: (device: Device) => Effect.Effect<readonly App[], Error>;
  };
  readonly preparation: {
    readonly prepare: (
      input: Input
    ) => Effect.Effect<Session, Error, Scope.Scope>;
  };
  readonly cleanup: () => Effect.Effect<void, Error>;
}
