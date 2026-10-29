import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect } from "effect";

import { performAndroidFill } from "../../src/services/android-runtime-backend.ts";

it.effect("confirms an SDK fill with matching readback", () =>
  Effect.gen(function* confirmed() {
    expect(yield* performAndroidFill(() => Promise.resolve({}))).toEqual({
      confirmation: "confirmed",
      outcome: "entered",
    });
  })
);

it.effect("records unreadable SDK fills as entered but unconfirmed", () =>
  Effect.gen(function* unconfirmed() {
    expect(
      yield* performAndroidFill(() =>
        Promise.resolve({ verification: "unconfirmed" })
      )
    ).toEqual({
      confirmation: "unconfirmed",
      outcome: "entered",
    });
    for (const reason of [
      "android_text_input_unverified",
      "input_unverified",
    ]) {
      let attempts = 0;
      expect(
        yield* performAndroidFill(() => {
          attempts += 1;
          return Promise.reject(
            new AppError("COMMAND_FAILED", "Readback unavailable", { reason })
          );
        })
      ).toEqual({ confirmation: "unconfirmed", outcome: "entered" });
      expect(attempts).toBe(1);
    }
  })
);

it.effect("preserves dispatch failures without claiming text was entered", () =>
  Effect.gen(function* failed() {
    const failure = yield* Effect.flip(
      performAndroidFill(() =>
        Promise.reject(
          new AppError("COMMAND_FAILED", "Target changed", {
            reason: "stale_ref",
          })
        )
      )
    );
    expect(failure).toMatchObject({
      backendReason: "stale_ref",
      code: "runtime_failed",
      operation: "fill",
    });
  })
);
