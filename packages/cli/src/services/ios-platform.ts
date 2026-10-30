import { Context, Effect, Layer } from "effect";

import type {
  IosApp,
  IosDevice,
  IosEnvironment,
  IosError,
  IosPreparationInput,
} from "./ios-contract.ts";
import { makeIosDiscovery } from "./ios-discovery.ts";
import {
  compareIosEnvironments,
  iosEnvironmentPermission,
} from "./ios-environment.ts";
import { makeIosPreparation } from "./ios-preparation.ts";
import { IosSimctl, iosSimctlHost } from "./ios-simctl.ts";
import type { NativeAppPlatformServices } from "./native-app-platform-services.ts";

export type IosPlatformService = NativeAppPlatformServices<
  IosDevice,
  IosApp,
  IosPreparationInput,
  { readonly device: IosDevice; readonly environment: IosEnvironment },
  IosError
> & {
  readonly environment: {
    readonly compare: typeof compareIosEnvironments;
    readonly permission: typeof iosEnvironmentPermission;
  };
};
export class IosPlatform extends Context.Service<
  IosPlatform,
  IosPlatformService
>()("contingency/IosPlatform") {}
export const IosPlatformLive = Layer.effect(
  IosPlatform,
  Effect.gen(function* iosServices() {
    const io = yield* IosSimctl;
    return {
      cleanup: () => Effect.void,
      discovery: makeIosDiscovery(io),
      environment: {
        compare: compareIosEnvironments,
        permission: iosEnvironmentPermission,
      },
      platform: "ios" as const,
      preparation: makeIosPreparation(io),
    };
  })
).pipe(Layer.provide(Layer.succeed(IosSimctl, iosSimctlHost)));
