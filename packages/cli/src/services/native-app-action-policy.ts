import { Effect } from "effect";

import type { AndroidObservation } from "./android-runtime-contract.ts";
import type { NativeAppActionPolicy } from "./native-app-runtime-contract.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

type NativeControls = Pick<AndroidObservation, "nodes">;

/** Target App names the journey; semantic input may reach any visible OS control. */
export const nativeAppActionPolicy = (
  error: (
    code: "target_unsupported" | "capability_missing"
  ) => PlatformRuntimeError,
  back: boolean
): NativeAppActionPolicy<
  NativeControls & {
    readonly id: string;
    readonly platform: "android" | "ios";
    readonly screenshot: AndroidObservation["screenshot"];
  }
> => ({
  publicAction: (captured, action) =>
    Effect.gen(function* validateAction() {
      if (action.type === "back") {
        if (!back) {
          return yield* Effect.fail(error("capability_missing"));
        }
        return;
      }
      if (action.type === "coordinate" || action.type === "press") {
        return yield* Effect.fail(error("capability_missing"));
      }
      const node = captured.nodes.find(
        (candidate) => candidate.target === action.target
      );
      if (
        node === undefined ||
        node.covered ||
        (action.type === "fill" && !node.editable)
      ) {
        return yield* Effect.fail(error("target_unsupported"));
      }
    }),
  unconfirmedFill: (captured, target) =>
    captured.nodes.some((node) => node.target === target && node.password),
});
