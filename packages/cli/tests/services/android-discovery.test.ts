import { AndroidWorkspaceObservation } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { makeAndroidDiscovery } from "../../src/services/android-discovery.ts";

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
    "shell am get-current-user": "0",
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
  "refuses inventory results when the selected identity changes during discovery",
  () =>
    Effect.gen(function* changedDuringDiscovery() {
      let captures = 0;
      const discovery = makeAndroidDiscovery({
        adb: (args) =>
          Effect.sync(() => {
            const command = args.slice(2).join(" ");
            if (command.includes("query-activities")) {
              return "dev.fixture/.Home";
            }
            if (command.startsWith("shell pm path")) {
              return "package:/data/app/fixture/base.apk";
            }
            if (command === "shell getprop ro.build.fingerprint") {
              captures += 1;
              return captures === 1 ? "build" : "changed";
            }
            return properties.get(command) ?? "";
          }),
        readApk: () =>
          Effect.succeed(
            "package: name='dev.fixture' versionCode='42' versionName='1.2'\napplication-label:'Fixture'"
          ),
      });
      expect((yield* Effect.flip(discovery.apps(device))).code).toBe(
        "android_device_unauthorized"
      );
    })
);

it.effect(
  "accepts an empty launcher inventory and refuses malformed app metadata",
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
              if (command.startsWith("shell pm path")) {
                return "package:/data/app/fixture/base.apk";
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
          expect((yield* Effect.flip(discovery.apps(device))).code).toBe(
            "android_discovery_failed"
          );
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
          Effect.fail({ code: "missing_sdk", message: "No emulator binary" }),
        readApk: () => Effect.die("Inventory must not read APKs"),
      });
      expect(yield* discovery.devices()).toMatchObject([
        { serial: "phone", state: "unauthorized" },
      ]);
    })
);
