import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import type { AndroidObservation } from "../../src/services/android-runtime-contract.ts";
import {
  iosCapabilities,
  iosRuntimeError,
} from "../../src/services/ios-runtime.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";

for (const password of [true, false]) {
  it.effect(
    `iOS enters ${password ? "secure" : "readable"} Variables on another app`,
    () =>
      Effect.scoped(
        Effect.gen(function* ordinaryFill() {
          const scope = yield* Effect.scope;
          const calls: string[] = [];
          const nodes: AndroidObservation["nodes"] = [
            {
              covered: false,
              editable: true,
              hittable: true,
              name: "Password",
              packageName: "com.apple.Preferences",
              password,
              role: "text-field",
              target: "@field",
            },
          ];
          const observation = {
            id: "one",
            nodes,
            platform: "ios" as const,
            screenshot: {
              capturedAt: "now",
              encoding: "base64" as const,
              format: "png" as const,
              image: "pixels",
            },
          };
          const runtime = yield* adaptNativeAppRuntime({
            backend: {
              activate: () =>
                Effect.sync(() => {
                  calls.push("activate");
                }),
              capture: () => Effect.succeed(observation),
              close: () => Effect.void,
              fill: (_target, text) =>
                Effect.sync(() => {
                  calls.push(text);
                  return {
                    confirmation: "confirmed" as const,
                    outcome: "entered" as const,
                  };
                }),
              recover: () => Effect.void,
              sessionId: "ios",
              validate: () => Effect.void,
            },
            capabilities: iosCapabilities,
            error: iosRuntimeError,
            policy: nativeAppActionPolicy(iosRuntimeError, false),
            startup: {
              device: { kind: "simulator" },
              platform: "ios",
              requiredCapabilities: ["private-input"],
              scope,
              targetApp: "fixture.app",
            },
          });
          const before = yield* runtime.observe();
          const result = yield* runtime.enterVariable(before.id, {
            target: "@field",
            value: Effect.succeed(Redacted.make("ordinary-value")),
            variable: "{{PASSWORD}}",
          });
          expect(result).toEqual({
            confirmation: password ? "unconfirmed" : "confirmed",
            outcome: "entered",
            variable: "{{PASSWORD}}",
          });
          expect(calls).toEqual(["ordinary-value"]);
          const after = yield* runtime.observe();
          yield* runtime.dispatch(after.id, {
            target: "@field",
            type: "activate",
          });
          expect(calls).toEqual(["ordinary-value", "activate"]);
        })
      )
  );
}
