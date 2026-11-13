import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect, Scope } from "effect";

import {
  performAndroidFill,
  helperReplacement,
  installAuthorizedAndroidHelper,
  requireReplaceableHelper,
} from "../../src/services/android-runtime-backend.ts";
import type { AndroidRuntimeStartInput } from "../../src/services/android-runtime-contract.ts";
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

it.effect(
  "only automatic authorization allows replacing a newer helper and still validates its identity",
  () =>
    Effect.gen(function* authorizedReplacement() {
      expect(
        yield* helperReplacement(
          helperListing(androidHelperRelease.versionCode + 1),
          true
        )
      ).toBe(true);
      expect(
        (yield* Effect.flip(
          helperReplacement(
            helperListing(androidHelperRelease.versionCode + 1),
            false
          )
        )).code
      ).toBe("helper_newer_installed");
      expect(
        yield* helperReplacement(
          helperListing(androidHelperRelease.versionCode),
          true
        )
      ).toBe(false);
      expect((yield* Effect.flip(helperReplacement("", true))).code).toBe(
        "helper_incompatible"
      );
    })
);

it.effect(
  "installs only the supported helper under device-bound authorization",
  () =>
    Effect.gen(function* authorizedHelperInstall() {
      const input: AndroidRuntimeStartInput = {
        device: {
          api: 36,
          avd: "fixture",
          fingerprint: "fixture",
          host: "local",
          serial: "selected",
        },
        installationGrant: {
          operation: "auto",
          replaceNewer: true,
          serial: "selected",
          sha256: androidHelperRelease.sha256,
        },
        platform: "android",
        requiredCapabilities: [],
        scope: yield* Scope.Scope,
        targetApp: "dev.fixture",
      };
      for (const installed of [
        null,
        androidHelperRelease.sha256,
        "older",
        "newer",
      ]) {
        const recorded: string[][] = [];
        const run = (args: readonly string[]) =>
          Effect.sync(() => {
            recorded.push([...args]);
            return args[0] === "shell"
              ? helperListing(
                  androidHelperRelease.versionCode +
                    (installed === "newer" ? 1 : 0)
                )
              : "Success";
          });
        yield* installAuthorizedAndroidHelper(
          input,
          installed,
          "/supported.apk",
          run
        );
        const mutations = recorded.filter((args) => args[0] !== "shell");
        if (installed === androidHelperRelease.sha256) {
          expect(mutations).toEqual([]);
        } else if (installed === "newer") {
          expect(mutations).toEqual([
            ["uninstall", androidHelperRelease.packageName],
            ["install", "--user", "0", "/supported.apk"],
          ]);
        } else {
          expect(mutations).toEqual([
            [
              "install",
              "--user",
              "0",
              ...(installed === null ? [] : ["-r"]),
              "/supported.apk",
            ],
          ]);
        }
      }
      const { installationGrant: _installationGrant, ...ungranted } = input;
      for (const grant of [
        undefined,
        {
          operation: "auto" as const,
          replaceNewer: true,
          serial: "other",
          sha256: androidHelperRelease.sha256,
        },
        {
          operation: "auto" as const,
          replaceNewer: false,
          serial: "selected",
          sha256: androidHelperRelease.sha256,
        },
      ]) {
        const commands: string[][] = [];
        const startup =
          grant === undefined
            ? ungranted
            : { ...ungranted, installationGrant: grant };
        const result = yield* Effect.flip(
          installAuthorizedAndroidHelper(
            startup,
            "newer",
            "/supported.apk",
            (args) =>
              Effect.sync(() => {
                commands.push([...args]);
                return helperListing(androidHelperRelease.versionCode + 1);
              })
          )
        );
        expect(result.code).toBe("helper_newer_installed");
        expect(commands.every((args) => args[0] === "shell")).toBe(true);
      }
    })
);
