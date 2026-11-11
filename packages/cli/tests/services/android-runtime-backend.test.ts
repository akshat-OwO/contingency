import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect } from "effect";

import {
  performAndroidFill,
  requireReplaceableHelper,
} from "../../src/services/android-runtime-backend.ts";
import { androidHelperRelease } from "../../src/services/android-runtime-contract.ts";

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

const helperListing = (versionCode: number) =>
  [
    "package:com.callstack.agentdevice.imehelper versionCode:99999",
    `package:${androidHelperRelease.packageName} versionCode:${versionCode}`,
  ].join("\r\n");

const replaceableHelperCode = (packageList: string) =>
  requireReplaceableHelper(packageList).pipe(
    Effect.match({
      onFailure: (error) => error.code,
      onSuccess: () => "replaceable",
    })
  );

it.effect("refuses a newer installed helper with an actionable reason", () =>
  Effect.gen(function* newerHelper() {
    const failure = yield* requireReplaceableHelper(
      helperListing(androidHelperRelease.versionCode + 6)
    ).pipe(Effect.flip);
    expect(failure.code).toBe("helper_newer_installed");
    expect(failure.message).toContain(androidHelperRelease.packageName);
    expect(failure.message).toContain("No input was sent.");
  })
);

it.effect("allows replacing an older or same-version helper", () =>
  Effect.gen(function* replaceable() {
    expect(
      yield* replaceableHelperCode(
        helperListing(androidHelperRelease.versionCode - 1)
      )
    ).toBe("replaceable");
    expect(
      yield* replaceableHelperCode(
        helperListing(androidHelperRelease.versionCode)
      )
    ).toBe("replaceable");
  })
);

it.effect("fails closed when the installed versionCode is unreadable", () =>
  Effect.gen(function* unreadable() {
    expect(yield* replaceableHelperCode("")).toBe("helper_incompatible");
    expect(
      yield* replaceableHelperCode(
        `package:${androidHelperRelease.packageName}.extra versionCode:1`
      )
    ).toBe("helper_incompatible");
  })
);
