import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { encodeIosBuildEntryHeader } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { parseApkBadging } from "../../src/services/android-discovery.ts";
import { androidInstallOutcome } from "../../src/services/android-preparation.ts";
import { makeTargetAppBuilds } from "../../src/services/target-app-builds.ts";
import type { TargetAppBuildReaders } from "../../src/services/target-app-builds.ts";

const badging = [
  "package: name='dev.shop' versionCode='7' versionName='1.7' platformBuildVersionName='16'",
  "application-label:'Shop'",
  "launchable-activity: name='dev.shop.MainActivity'  label='Shop' icon=''",
].join("\n");
/** Plists here are JSON already, so the reader passes the file through. */
const readers: TargetAppBuildReaders = {
  badging: () => Effect.succeed(badging),
  plist: (file) => Effect.tryPromise(() => readFile(file, "utf-8")),
};
type PlistOverrides = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

const machO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
const info = (overrides: PlistOverrides = {}) =>
  Buffer.from(
    JSON.stringify({
      CFBundleExecutable: "Shop",
      CFBundleIdentifier: "dev.shop",
      CFBundleName: "Shop",
      CFBundleSupportedPlatforms: ["iPhoneSimulator"],
      CFBundleVersion: "42",
      ...overrides,
    })
  );

/** The upload body the Workspace sends for a `.app` folder. */
const framed = (entries: readonly (readonly [string, Buffer])[]) =>
  Buffer.concat(
    entries.flatMap(([relative, bytes]) => [
      encodeIosBuildEntryHeader(relative, bytes.length),
      bytes,
    ])
  );

/**
 * Delivers a body in small pieces, as a socket would.
 * @yields {Buffer} Each piece, in order.
 */
const chunks = async function* chunks(body: Buffer, size = 7) {
  for (let offset = 0; offset < body.length; offset += size) {
    yield body.subarray(offset, offset + size);
  }
};

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false
  );
const executable = (file: string) =>
  access(file, constants.X_OK).then(
    () => true,
    () => false
  );

const app = (overrides?: PlistOverrides) =>
  framed([
    ["Shop.app/Info.plist", info(overrides)],
    ["Shop.app/Shop", machO],
    ["Shop.app/Frameworks/Pay.framework/Pay", machO],
    ["Shop.app/Frameworks/Pay.framework/Info.plist", Buffer.from("{}")],
    ["Shop.app/Assets.car", Buffer.from("not a binary")],
  ]);

it.effect(
  "rebuilds an uploaded simulator .app and restores executable bits on every Mach-O file",
  () =>
    Effect.scoped(
      Effect.gen(function* receivesApp() {
        const builds = yield* makeTargetAppBuilds(readers);
        const uploaded = yield* builds.receiveIos(chunks(app()));
        expect(uploaded).toMatchObject({
          build: "42",
          bundleId: "dev.shop",
          label: "Shop",
          name: "Shop.app",
        });
        expect(path.basename(uploaded.appPath)).toBe("Shop.app");
        yield* Effect.promise(async () => {
          expect(await executable(path.join(uploaded.appPath, "Shop"))).toBe(
            true
          );
          expect(
            await executable(
              path.join(uploaded.appPath, "Frameworks/Pay.framework/Pay")
            )
          ).toBe(true);
          expect(
            await executable(path.join(uploaded.appPath, "Assets.car"))
          ).toBe(false);
        });
      })
    )
);

it.effect(
  "refuses folders that are not simulator .app builds with a specific reason, keeping nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* refusesBuilds() {
        const builds = yield* makeTargetAppBuilds(readers);
        const refused = (body: Buffer) =>
          builds.receiveIos(chunks(body)).pipe(Effect.flip);
        expect(
          (yield* refused(framed([["Shop/Info.plist", info()]]))).code
        ).toBe("not_app_bundle");
        const incomplete = yield* refused(
          app({ CFBundleExecutable: undefined, CFBundleVersion: "" })
        );
        expect(incomplete).toMatchObject({
          code: "info_plist_incomplete",
          message: "Info.plist lacks CFBundleVersion, CFBundleExecutable.",
        });
        expect(
          (yield* refused(app({ CFBundleSupportedPlatforms: ["iPhoneOS"] })))
            .code
        ).toBe("device_build");
        expect((yield* refused(framed([["Shop.app/Other", machO]]))).code).toBe(
          "info_plist_unreadable"
        );
        expect(
          (yield* refused(app({ CFBundleExecutable: "Missing" }))).code
        ).toBe("executable_missing");
        expect(
          (yield* refused(framed([["Shop.app/../escape", machO]]))).code
        ).toBe("upload_invalid");
        const truncated = app();
        expect((yield* refused(truncated.subarray(0, -3))).code).toBe(
          "upload_invalid"
        );
      })
    )
);

it.effect(
  "hands an upload to one session and deletes it when that session's scope closes",
  () =>
    Effect.gen(function* claimsBuild() {
      const outer = yield* Scope.make();
      const builds = yield* makeTargetAppBuilds(readers).pipe(
        Scope.provide(outer)
      );
      const uploaded = yield* builds.receiveIos(chunks(app()));
      const session = yield* Scope.make();
      expect(
        (yield* builds
          .claim("android", uploaded.appPath, session)
          .pipe(Effect.flip)).code
      ).toBe("build_unknown");
      expect(
        (yield* builds
          .claim("ios", "/Users/someone/Typed.app", session)
          .pipe(Effect.flip)).code
      ).toBe("build_unknown");
      const claimed = yield* builds.claim("ios", uploaded.appPath, session);
      expect(claimed.path).toBe(uploaded.appPath);
      // A claimed upload belongs to its session: discarding it does nothing,
      // and no second session can take it.
      yield* builds.discard(uploaded.id);
      expect(yield* Effect.promise(() => exists(uploaded.appPath))).toBe(true);
      const other = yield* Scope.make();
      expect(
        (yield* builds.claim("ios", uploaded.appPath, other).pipe(Effect.flip))
          .code
      ).toBe("build_unknown");
      yield* Scope.close(session, Exit.void);
      expect(yield* Effect.promise(() => exists(uploaded.appPath))).toBe(false);

      // An unclaimed upload is deleted on discard, and the rest on close.
      const discarded = yield* builds.receiveIos(chunks(app()));
      yield* builds.discard(discarded.id);
      expect(yield* Effect.promise(() => exists(discarded.appPath))).toBe(
        false
      );
      const left = yield* builds.receiveIos(chunks(app()));
      yield* Scope.close(outer, Exit.void);
      expect(yield* Effect.promise(() => exists(left.appPath))).toBe(false);
    })
);

it.effect(
  "reads an uploaded .apk as an installed app and refuses files that are not APKs",
  () =>
    Effect.scoped(
      Effect.gen(function* receivesApk() {
        const builds = yield* makeTargetAppBuilds(readers);
        const zip = Buffer.concat([
          Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          Buffer.alloc(64),
        ]);
        const uploaded = yield* builds.receiveAndroid(chunks(zip), "shop.apk");
        expect(uploaded.app).toEqual({
          label: "Shop",
          launchActivity: "dev.shop/.MainActivity",
          package: "dev.shop",
          versionCode: "7",
          versionName: "1.7",
        });
        const session = yield* Scope.make();
        const claimed = yield* builds.claim(
          "android",
          uploaded.apkPath,
          session
        );
        expect(claimed.sha256).toMatch(/^[a-f0-9]{64}$/u);
        yield* Scope.close(session, Exit.void);
        expect(yield* Effect.promise(() => exists(uploaded.apkPath))).toBe(
          false
        );
        expect(
          (yield* builds
            .receiveAndroid(chunks(zip), "shop.zip")
            .pipe(Effect.flip)).code
        ).toBe("not_apk");
        expect(
          (yield* builds
            .receiveAndroid(chunks(Buffer.from("text")), "shop.apk")
            .pipe(Effect.flip)).code
        ).toBe("not_apk");
      })
    )
);

it("validates APK badging as discovery validates an installed app", () => {
  expect(parseApkBadging(badging)?.launchActivity).toBe(
    "dev.shop/.MainActivity"
  );
  expect(
    parseApkBadging(
      "package: name='dev.shop' versionCode='7' versionName='1.7'"
    )
  ).toBeUndefined();
});

it.effect(
  "reports the device's reason when it refuses an install, and never uninstalls",
  () =>
    Effect.gen(function* refusesInstall() {
      const downgrade = yield* androidInstallOutcome(
        "Performing Streamed Install\nadb: failed to install shop.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected]"
      ).pipe(Effect.flip);
      expect(downgrade.code).toBe("app_installation_refused");
      expect(downgrade.message).toContain("INSTALL_FAILED_VERSION_DOWNGRADE");
      expect(downgrade.message).toContain("Nothing was uninstalled");
      const signature = yield* androidInstallOutcome(
        "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]"
      ).pipe(Effect.flip);
      expect(signature.message).toContain("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
      yield* androidInstallOutcome("Performing Streamed Install\nSuccess");
    })
);
