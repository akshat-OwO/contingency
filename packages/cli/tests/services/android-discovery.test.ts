import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AndroidWorkspaceObservation } from "@contingency/protocol";
import type { AndroidDiscoveredAppsEvent } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";

import {
  describeHostError,
  makeAndroidDiscovery,
  makeFileAndroidAppMetadataCache,
} from "../../src/services/android-discovery.ts";

const device = {
  api: 36,
  avd: "Pixel_9",
  fingerprint: "build",
  host: "local",
  serial: "emulator-5554",
} as const;
const properties = new Map(
  Object.entries({
    "emu avd name": "Pixel_9\nOK",
    "get-state": "device",
    "shell getprop ro.build.fingerprint": "build",
    "shell getprop ro.build.version.release": "16",
    "shell getprop ro.build.version.sdk": "36",
    "shell getprop ro.kernel.qemu": "1",
    "shell getprop ro.product.model": "Pixel 9",
  })
);

it.effect(
  "lists running and unauthorized devices without querying an unauthorized device",
  () =>
    Effect.gen(function* listDevices() {
      const calls: string[][] = [];
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            calls.push([...args]);
            if (args[0] === "devices") {
              return "List of devices attached\nemulator-5554 device product:pixel\nphone unauthorized\n";
            }
            expect(args.slice(0, 2)).toEqual(["-s", device.serial]);
            return properties.get(args.slice(2).join(" ")) ?? "";
          }),
        readApk: () => Effect.die("Device listing must not read APKs"),
      });
      expect(yield* discovery.devices()).toEqual([
        {
          api: 36,
          avd: "Pixel_9",
          fingerprint: "build",
          kind: "emulator",
          model: "Pixel 9",
          release: "16",
          serial: device.serial,
          state: "device",
        },
        {
          api: null,
          avd: null,
          fingerprint: null,
          kind: "physical",
          model: null,
          release: null,
          serial: "phone",
          state: "unauthorized",
        },
      ]);
      expect(calls.length).toBe(7);
    })
);

it.effect(
  "reads launchable app metadata on only the explicitly selected device",
  () =>
    Effect.gen(function* listApps() {
      const calls: string[][] = [];
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            calls.push([...args]);
            expect(args.slice(0, 2)).toEqual(["-s", device.serial]);
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.fixture/.Home\ndev.fixture/.Other";
            }
            if (command === "shell pm path --user 0 dev.fixture") {
              return "package:/data/app/fixture/base.apk\npackage:/data/app/fixture/split.apk";
            }
            return properties.get(command) ?? "";
          }),
        readApk: (serial, apk) =>
          Effect.sync(() => {
            expect([serial, apk]).toEqual([
              device.serial,
              "/data/app/fixture/base.apk",
            ]);
            return "package: name='dev.fixture' versionCode='42' versionName='1.2'\napplication-label:'Fixture Shop'";
          }),
      });
      expect(yield* discovery.apps(device)).toEqual([
        {
          label: "Fixture Shop",
          launchActivity: "dev.fixture/.Home",
          package: "dev.fixture",
          versionCode: "42",
          versionName: "1.2",
        },
      ]);
      expect(
        calls.every(
          (args) =>
            !args.some((arg) =>
              ["install", "start", "forward", "push", "force-stop"].includes(
                arg
              )
            )
        )
      ).toBe(true);
    })
);

it.effect(
  "refuses unauthorized or changed devices before reading their app inventory",
  () =>
    Effect.gen(function* refuseApps() {
      for (const state of ["unauthorized", "offline", "device"]) {
        const calls: string[] = [];
        const discovery = makeAndroidDiscovery({
          adb: (args) =>
            Effect.sync(() => {
              const command = args.slice(2).join(" ");
              calls.push(command);
              if (command === "get-state") {
                return state;
              }
              if (command.includes("fingerprint")) {
                return "changed";
              }
              return properties.get(command) ?? "";
            }),
          readApk: () => Effect.die("Unauthorized devices cannot read APKs"),
        });
        expect((yield* Effect.flip(discovery.apps(device))).code).toBe(
          "android_device_unauthorized"
        );
        expect(
          calls.some((command) => command.includes("query-activities"))
        ).toBe(false);
      }
    })
);

it.effect(
  "refuses an API level outside the Support Matrix before touching the device",
  () =>
    Effect.gen(function* refuseApi() {
      const discovery = makeAndroidDiscovery({
        adb: () => Effect.die("An unsupported API level must not reach ADB"),
        readApk: () => Effect.die("An unsupported API level cannot read APKs"),
      });
      const refused = yield* Effect.flip(
        discovery.apps({ ...device, api: 29 })
      );
      expect(refused.code).toBe("android_api_unsupported");
      expect(refused.message).toContain("below 30 are unsupported");
    })
);

it.effect(
  "decodes present and missing element bounds and rejects invalid rectangles",
  () =>
    Effect.gen(function* decodeBounds() {
      const node = {
        covered: false,
        editable: false,
        name: "Continue",
        password: false,
        role: "button",
        target: "@1",
      };
      const frame = {
        capturedAt: "now",
        height: 2400,
        id: "observation-1",
        image: null,
        width: 1080,
      };
      const bounds = { height: 60, width: 200, x: 12, y: 300 };
      const decoded = yield* Schema.decodeUnknownEffect(
        AndroidWorkspaceObservation
      )({ ...frame, nodes: [node, { ...node, bounds }] });
      expect(decoded.nodes[0]).not.toHaveProperty("bounds");
      expect(decoded.nodes[1]?.bounds).toEqual(bounds);
      expect(decoded.id).toBe(frame.id);
      yield* Effect.flip(
        Schema.decodeUnknownEffect(AndroidWorkspaceObservation)({
          ...frame,
          nodes: [{ ...node, bounds: { ...bounds, width: -1 } }],
        })
      );
    })
);

it.effect(
  "refuses inventory results without emitting events or writing cache when identity changes during discovery",
  () =>
    Effect.gen(function* changedDuringDiscovery() {
      let captures = 0;
      let cacheWrites = 0;
      const events: AndroidDiscoveredAppsEvent[] = [];
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.fixture/.Home";
            }
            if (command.includes("pm list packages")) {
              return "package:/data/app/fixture/base.apk=dev.fixture versionCode:42";
            }
            if (command === "shell getprop ro.build.fingerprint") {
              captures += 1;
              return captures === 1 ? "build" : "changed";
            }
            return properties.get(command) ?? "";
          }),
        cache: {
          load: () => Effect.succeed(new Map()),
          save: () =>
            Effect.sync(() => {
              cacheWrites += 1;
            }),
        },
        readApk: () =>
          Effect.succeed(
            "package: name='dev.fixture' versionCode='42' versionName='1.2'\napplication-label:'Fixture'"
          ),
      });
      const error = yield* Effect.flip(
        discovery.appsStream(device).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            })
          )
        )
      );
      expect(error.code).toBe("android_device_unauthorized");
      expect(events).toEqual([]);
      expect(cacheWrites).toBe(0);
    })
);

it.effect(
  "refuses enrichment updates and skips caching if identity drifts after snapshot",
  () =>
    Effect.gen(function* changedDuringEnrichment() {
      let captures = 0;
      let cacheWrites = 0;
      const events: AndroidDiscoveredAppsEvent[] = [];
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.fixture/.Home";
            }
            if (command.includes("pm list packages")) {
              return "package:/data/app/fixture/base.apk=dev.fixture versionCode:42";
            }
            if (command === "shell getprop ro.build.fingerprint") {
              captures += 1;
              // First two checks pass (before & after fast inventory), third fails before publishing metadata.
              return captures <= 2 ? "build" : "changed";
            }
            return properties.get(command) ?? "";
          }),
        cache: {
          load: () => Effect.succeed(new Map()),
          save: () =>
            Effect.sync(() => {
              cacheWrites += 1;
            }),
        },
        readApk: () =>
          Effect.succeed(
            "package: name='dev.fixture' versionCode='42' versionName='1.2'\napplication-label:'Fixture'"
          ),
      });
      const error = yield* Effect.flip(
        discovery.appsStream(device).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            })
          )
        )
      );
      expect(error.code).toBe("android_device_unauthorized");
      // Snapshot was verified, but the drifted metadata update is neither emitted nor cached.
      expect(events.map((event) => event._tag)).toEqual(["snapshot"]);
      expect(cacheWrites).toBe(0);
    })
);

it.effect(
  "persists already-verified cache entries when a subscriber cancels during enrichment",
  () =>
    Effect.scoped(
      Effect.gen(function* saveOnCancel() {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() =>
            mkdtemp(path.join(tmpdir(), "discovery-cancel-cache-"))
          ),
          (owned) =>
            Effect.promise(() => rm(owned, { force: true, recursive: true }))
        );
        const cache = makeFileAndroidAppMetadataCache(
          path.join(dir, "cache.json"),
          10
        );
        const firstMetadataSeen = yield* Deferred.make<boolean>();
        const secondApkStarted = yield* Deferred.make<boolean>();
        const releaseSecondApk = yield* Deferred.make<string>();

        const discovery = makeAndroidDiscovery({
          adb: (args) =>
            Effect.sync(() => {
              const command = args.slice(2).join(" ");
              if (command.includes("query-activities")) {
                return "dev.one/.Main\ndev.two/.Main";
              }
              if (command.includes("pm list packages")) {
                return [
                  "package:/data/app/one/base.apk=dev.one versionCode:1",
                  "package:/data/app/two/base.apk=dev.two versionCode:2",
                ].join("\n");
              }
              return properties.get(command) ?? "";
            }),
          cache,
          readApk: (_serial, apk) => {
            if (apk.includes("/one/")) {
              return Effect.succeed(
                "package: name='dev.one' versionCode='1' versionName='1.0'\napplication-label:'App One'"
              );
            }
            return Deferred.succeed(secondApkStarted, true).pipe(
              Effect.andThen(Deferred.await(releaseSecondApk))
            );
          },
        });

        const fiber = yield* discovery.appsStream(device).pipe(
          Stream.runForEach((event) =>
            event._tag === "metadata" && event.package === "dev.one"
              ? Deferred.succeed(firstMetadataSeen, true).pipe(Effect.asVoid)
              : Effect.void
          ),
          Effect.forkChild
        );

        yield* Deferred.await(firstMetadataSeen);
        yield* Deferred.await(secondApkStarted);

        // Let a second overlapping stream finish and persist a distinct label
        // before canceling the first stream.
        const secondDiscovery = makeAndroidDiscovery({
          adb: (args) =>
            Effect.sync(() => {
              const command = args.slice(2).join(" ");
              if (command.includes("query-activities")) {
                return "dev.three/.Main";
              }
              if (command.includes("pm list packages")) {
                return "package:/data/app/three/base.apk=dev.three versionCode:3";
              }
              return properties.get(command) ?? "";
            }),
          cache,
          readApk: () =>
            Effect.succeed(
              "package: name='dev.three' versionCode='3' versionName='3.0'\napplication-label:'App Three'"
            ),
        });
        expect(yield* secondDiscovery.apps(device)).toMatchObject([
          { label: "App Three", package: "dev.three" },
        ]);

        // Cancel stream A while dev.two is still pending; both verified labels must remain on disk.
        yield* Fiber.interrupt(fiber);

        const saved = yield* cache.load();
        expect(
          [...saved.values()].map((entry) => entry.label).toSorted()
        ).toEqual(["App One", "App Three"]);
      })
    )
);

it.effect(
  "accepts an empty launcher inventory and falls back when one app has mismatched metadata",
  () =>
    Effect.gen(function* invalidMetadata() {
      for (const output of ["No activities found", "dev.fixture/.Home"]) {
        const discovery = makeAndroidDiscovery({
          adb: (args) =>
            Effect.sync(() => {
              const command = args.slice(2).join(" ");
              if (command.includes("query-activities")) {
                return output;
              }
              if (command.includes("pm list packages")) {
                return "package:/data/app/fixture/base.apk=dev.fixture versionCode:42";
              }
              return properties.get(command) ?? "";
            }),
          readApk: () =>
            Effect.succeed(
              "package: name='dev.other' versionCode='42' versionName='1.2'\napplication-label:'Other'"
            ),
        });
        if (output === "No activities found") {
          expect(yield* discovery.apps(device)).toEqual([]);
        } else {
          expect(yield* discovery.apps(device)).toEqual([
            {
              label: "dev.fixture",
              launchActivity: "dev.fixture/.Home",
              package: "dev.fixture",
              versionCode: "42",
              versionName: "",
            },
          ]);
        }
      }
    })
);

it.effect(
  "keeps unlabeled applications and other apps in the same inventory",
  () =>
    Effect.gen(function* labelFallbacks() {
      for (const launcherLabel of ["Activity label", ""]) {
        const discovery = makeAndroidDiscovery({
          adb: (args) =>
            Effect.sync(() => {
              const command = args.slice(2).join(" ");
              if (command.includes("query-activities")) {
                return "dev.activity/.Home\ndev.normal/.Home";
              }
              if (command.startsWith("shell pm path")) {
                return `package:/data/app/${args.at(-1)}/base.apk`;
              }
              return properties.get(command) ?? "";
            }),
          readApk: (_serial, apk) =>
            Effect.succeed(
              apk.includes("dev.activity")
                ? `package: name='dev.activity' versionCode='1' versionName='1.0'\napplication: label='' icon=''\nlaunchable-activity: name='dev.activity.Home'  label='${launcherLabel}' icon=''`
                : "package: name='dev.normal' versionCode='2' versionName='2.0'\napplication-label:'Normal app'"
            ),
        });
        const apps = yield* discovery.apps(device);
        expect(
          apps.map(({ package: packageName, label }) => ({
            label,
            packageName,
          }))
        ).toEqual([
          {
            label: launcherLabel || "dev.activity",
            packageName: "dev.activity",
          },
          { label: "Normal app", packageName: "dev.normal" },
        ]);
      }
    })
);

it.effect("includes stopped AVDs without duplicating a running emulator", () =>
  Effect.gen(function* inventory() {
    const discovery = makeAndroidDiscovery({
      adb: (args) =>
        Effect.succeed(
          args[0] === "devices"
            ? "List of devices attached\nemulator-5554 device\nphone unauthorized\n"
            : (properties.get(args.slice(2).join(" ")) ?? "")
        ),
      avds: () => Effect.succeed("Pixel_9\nPixel_9_API_30\nPixel_9_API_30\n"),
      readApk: () => Effect.die("Inventory must not read APKs"),
    });
    const devices = yield* discovery.devices();
    expect(devices.map(({ avd, state }) => ({ avd, state }))).toEqual([
      { avd: "Pixel_9", state: "device" },
      { avd: null, state: "unauthorized" },
      { avd: "Pixel_9_API_30", state: "stopped" },
    ]);
  })
);

it.effect(
  "keeps connected devices visible when the emulator inventory is unavailable",
  () =>
    Effect.gen(function* unavailableInventory() {
      const discovery = makeAndroidDiscovery({
        adb: () =>
          Effect.succeed("List of devices attached\nphone unauthorized\n"),
        avds: () =>
          Effect.fail({
            code: "android_discovery_failed",
            message: "No emulator binary",
          }),
        readApk: () => Effect.die("Inventory must not read APKs"),
      });
      expect(yield* discovery.devices()).toMatchObject([
        { serial: "phone", state: "unauthorized" },
      ]);
    })
);

it.effect(
  "streams the fast launchable snapshot before APK enrichment finishes",
  () =>
    Effect.gen(function* fastSnapshot() {
      const releaseApk = yield* Deferred.make<string>();
      const snapshotSeen = yield* Deferred.make<boolean>();
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.fixture/.Home";
            }
            if (command.includes("pm list packages")) {
              return "package:/data/app/fixture/base.apk=dev.fixture versionCode:42";
            }
            return properties.get(command) ?? "";
          }),
        readApk: () => Deferred.await(releaseApk),
      });

      const events: unknown[] = [];
      const fiber = yield* discovery.appsStream(device).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* record() {
            events.push(event);
            if (event._tag === "snapshot") {
              yield* Deferred.succeed(snapshotSeen, true);
            }
          })
        ),
        Effect.forkChild
      );

      yield* Deferred.await(snapshotSeen);
      expect(events).toEqual([
        {
          _tag: "snapshot",
          apps: [
            {
              label: "dev.fixture",
              launchActivity: "dev.fixture/.Home",
              package: "dev.fixture",
              versionCode: "42",
              versionName: "",
            },
          ],
        },
      ]);

      yield* Deferred.succeed(
        releaseApk,
        "package: name='dev.fixture' versionCode='42' versionName='1.2'\napplication-label:'Fixture Shop'"
      );
      yield* Fiber.join(fiber);
      expect(events).toEqual([
        events[0],
        {
          _tag: "metadata",
          label: "Fixture Shop",
          package: "dev.fixture",
          versionCode: "42",
          versionName: "1.2",
        },
      ]);
    })
);

it.effect(
  "retries a transient APK metadata read once and falls back per app without failing the listing",
  () =>
    Effect.gen(function* resilientEnrichment() {
      const attempts = new Map<string, number>();
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "com.android.settings/.Settings\ndev.flaky/.Main\ndev.ok/.Main";
            }
            if (command.includes("pm list packages")) {
              return [
                "package:/system_ext/priv-app/SettingsGoogle/SettingsGoogle.apk=com.android.settings versionCode:36",
                "package:/data/app/flaky/base.apk=dev.flaky versionCode:7",
                "package:/data/app/ok/base.apk=dev.ok versionCode:9",
              ].join("\n");
            }
            return properties.get(command) ?? "";
          }),
        readApk: (_serial, apk) => {
          const count = (attempts.get(apk) ?? 0) + 1;
          attempts.set(apk, count);
          if (apk.includes("SettingsGoogle")) {
            return Effect.fail({
              code: "android_app_metadata_unavailable" as const,
              message:
                "aapt2 dump badging failed (exit 1): could not identify format of APK",
            });
          }
          if (apk.includes("flaky") && count === 1) {
            return Effect.fail({
              code: "android_app_metadata_unavailable" as const,
              message: "adb exec-out returned empty AndroidManifest.xml",
            });
          }
          return Effect.succeed(
            apk.includes("flaky")
              ? "package: name='dev.flaky' versionCode='7' versionName='1.0'\napplication-label:'Flaky App'"
              : "package: name='dev.ok' versionCode='9' versionName='2.0'\napplication-label:'OK App'"
          );
        },
      });

      const apps = yield* discovery.apps(device);
      expect(apps).toEqual([
        {
          label: "com.android.settings",
          launchActivity: "com.android.settings/.Settings",
          package: "com.android.settings",
          versionCode: "36",
          versionName: "",
        },
        {
          label: "Flaky App",
          launchActivity: "dev.flaky/.Main",
          package: "dev.flaky",
          versionCode: "7",
          versionName: "1.0",
        },
        {
          label: "OK App",
          launchActivity: "dev.ok/.Main",
          package: "dev.ok",
          versionCode: "9",
          versionName: "2.0",
        },
      ]);
      expect(
        attempts.get("/system_ext/priv-app/SettingsGoogle/SettingsGoogle.apk")
      ).toBe(2);
      expect(attempts.get("/data/app/flaky/base.apk")).toBe(2);
      expect(attempts.get("/data/app/ok/base.apk")).toBe(1);
    })
);

it.effect(
  "still lists launchable apps when Android SDK build-tools are missing",
  () =>
    Effect.gen(function* missingBuildTools() {
      let readCalls = 0;
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.one/.Main\ndev.two/.Main";
            }
            if (command.includes("pm list packages")) {
              return [
                "package:/data/app/one/base.apk=dev.one versionCode:1",
                "package:/data/app/two/base.apk=dev.two versionCode:2",
              ].join("\n");
            }
            return properties.get(command) ?? "";
          }),
        readApk: () => {
          readCalls += 1;
          return Effect.fail({
            code: "android_build_tools_missing" as const,
            message: "Install Android SDK build-tools in Android Studio.",
          });
        },
      });

      const apps = yield* discovery.apps(device);
      expect(apps).toEqual([
        {
          label: "dev.one",
          launchActivity: "dev.one/.Main",
          package: "dev.one",
          versionCode: "1",
          versionName: "",
        },
        {
          label: "dev.two",
          launchActivity: "dev.two/.Main",
          package: "dev.two",
          versionCode: "2",
          versionName: "",
        },
      ]);
      expect(readCalls).toBeGreaterThanOrEqual(1);
    })
);

it.effect(
  "persists resolved labels on disk and invalidates when APK path or version changes",
  () =>
    Effect.scoped(
      Effect.gen(function* cachedMetadata() {
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() =>
            mkdtemp(path.join(tmpdir(), "discovery-cache-"))
          ),
          (owned) =>
            Effect.promise(() => rm(owned, { force: true, recursive: true }))
        );
        const cache = makeFileAndroidAppMetadataCache(
          path.join(dir, "cache.json"),
          10
        );
        let apkPath = "/data/app/~~v1==/dev.shop-1/base.apk";
        let label = "Shop v1";
        let readCalls = 0;

        const make = () =>
          makeAndroidDiscovery({
            adb: (args) =>
              Effect.sync(() => {
                const command = args.slice(2).join(" ");
                if (command.includes("query-activities")) {
                  return "dev.shop/.Main";
                }
                if (command.includes("pm list packages")) {
                  return `package:${apkPath}=dev.shop versionCode:1`;
                }
                return properties.get(command) ?? "";
              }),
            cache,
            readApk: () => {
              readCalls += 1;
              return Effect.succeed(
                `package: name='dev.shop' versionCode='1' versionName='1.0'\napplication-label:'${label}'`
              );
            },
          });

        // First call populates the disk cache.
        const first = yield* make().apps(device);
        expect(first[0]?.label).toBe("Shop v1");
        expect(readCalls).toBe(1);

        // Second call (new service instance) hits the cache immediately in the snapshot without calling readApk.
        const secondEvents = yield* Stream.runCollect(
          make().appsStream(device)
        );
        expect(secondEvents).toEqual([
          {
            _tag: "snapshot",
            apps: [
              {
                label: "Shop v1",
                launchActivity: "dev.shop/.Main",
                package: "dev.shop",
                versionCode: "1",
                versionName: "1.0",
              },
            ],
          },
        ]);
        expect(readCalls).toBe(1);

        // Reinstall with same versionCode under a new randomized /data/app path invalidates cache.
        apkPath = "/data/app/~~v2==/dev.shop-2/base.apk";
        label = "Shop v2";
        const third = yield* make().apps(device);
        expect(third[0]?.label).toBe("Shop v2");
        expect(readCalls).toBe(2);
      })
    )
);

it.effect(
  "keeps the already-verified snapshot when ADB briefly disconnects during background enrichment",
  () =>
    Effect.gen(function* transientDisconnect() {
      let stateChecks = 0;
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command === "get-state") {
              stateChecks += 1;
              return stateChecks <= 2 ? "device" : "offline";
            }
            if (command.includes("query-activities")) {
              return "com.android.settings/.Settings";
            }
            if (command.includes("pm list packages")) {
              return "package:/system_ext/priv-app/SettingsGoogle/SettingsGoogle.apk=com.android.settings versionCode:36";
            }
            return properties.get(command) ?? "";
          }),
        readApk: () =>
          Effect.fail({
            code: "android_app_metadata_unavailable" as const,
            message: "ADB device disconnected",
          }),
      });
      expect(yield* discovery.apps(device)).toEqual([
        {
          label: "com.android.settings",
          launchActivity: "com.android.settings/.Settings",
          package: "com.android.settings",
          versionCode: "36",
          versionName: "",
        },
      ]);
    })
);

it("formats actionable host error causes for timeouts, disconnects, missing binaries, and stderr", () => {
  expect(
    describeHostError("adb", ["-s", "emulator-5554", "shell", "pm"], {
      killed: true,
      signal: "SIGTERM",
    })
  ).toContain("timed out after 30s");
  expect(
    describeHostError("adb", ["-s", "emulator-5554", "shell", "pm"], {
      code: 1,
      stderr: "adb: device offline\n",
    })
  ).toContain("ADB device disconnected");
  expect(
    describeHostError("aapt2", ["dump", "badging", "base.apk"], {
      code: "ENOENT",
    })
  ).toContain("command not found");
  expect(
    describeHostError("aapt2", ["dump", "badging", "base.apk"], {
      code: 1,
      stderr: "base.apk: error: could not identify format of APK.\n",
    })
  ).toContain("exit 1");
});
