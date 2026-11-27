import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect } from "effect";

import { iosRuntimeError } from "../../src/services/ios-runtime.ts";
import { performNativeAppFill } from "../../src/services/native-app-fill.ts";

it.effect(
  "reports an iOS read-back mismatch as entered but unconfirmed instead of failing the runtime",
  () =>
    Effect.gen(function* mismatch() {
      for (const cause of [
        new AppError("TEXT_ENTRY_MISMATCH", "read-back did not match", {
          runnerErrorCode: "TEXT_ENTRY_MISMATCH",
        }),
        new AppError("COMMAND_FAILED", "read-back did not match", {
          runnerErrorCode: "TEXT_ENTRY_MISMATCH",
        }),
      ]) {
        let attempts = 0;
        expect(
          yield* performNativeAppFill(() => {
            attempts += 1;
            return Promise.reject(cause);
          }, iosRuntimeError)
        ).toEqual({ confirmation: "unconfirmed", outcome: "entered" });
        expect(attempts).toBe(1);
      }
    })
);

it.effect(
  "still fails an iOS fill the runner could not type, naming it by Failure Reference",
  () =>
    Effect.gen(function* notTyped() {
      const failure = yield* Effect.flip(
        performNativeAppFill(
          () =>
            Promise.reject(
              new AppError("COMMAND_FAILED", "no focused text input", {
                runnerErrorCode: "TEXT_INPUT_NOT_FOCUSED",
              })
            ),
          iosRuntimeError
        )
      );
      expect(failure).toMatchObject({
        code: "runtime_failed",
        operation: "fill",
      });
      expect(failure.backendReason).toBeUndefined();
      expect(failure.failureReference).toBeDefined();
    })
);
