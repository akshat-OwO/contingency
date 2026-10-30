import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import type { Scope } from "effect";
import { Deferred, Effect, Exit, Fiber, FileSystem } from "effect";

import { iosError } from "../../src/services/ios-contract.ts";
import type {
  IosDevice,
  IosPreparationInput,
} from "../../src/services/ios-contract.ts";
import { makeIosDiscovery } from "../../src/services/ios-discovery.ts";
import {
  compareIosEnvironments,
  iosEnvironmentPermission,
} from "../../src/services/ios-environment.ts";
import { makeIosPreparation } from "../../src/services/ios-preparation.ts";
import { iosRunnerArguments } from "../../src/services/ios-runner.ts";
import type { IosSimctlService } from "../../src/services/ios-simctl.ts";

const selected: IosDevice = {
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  kind: "simulator",
  name: "User template",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  runtimeVersion: "26.5",
  udid: "11111111-1111-1111-1111-111111111111",
};
const session = "22222222-2222-2222-2222-222222222222";
const other = "33333333-3333-3333-3333-333333333333";
const environment = {
  build: "7",
  bundleId: "com.example.target",
  deviceType: selected.deviceType,
  runtimeVersion: "26.5",
};
const app = {
  build: "7",
  bundleId: environment.bundleId,
  label: "Target",
  path: "/template/Target.app",
};
const fakeHost = () => {
  const commands: string[][] = [];
  const inventoryReads: string[] = [];

  const io: IosSimctlService = {
    apps: () => Effect.succeed([app]),
    architecture: () => "arm64",
    device: (args) =>
      Effect.sync(() => {
        commands.push([...args]);
        return "";
      }),
    devices: () =>
      Effect.sync(() => {
        inventoryReads.push("devices");
        return JSON.stringify({
          devices: {
            [selected.runtime]: [
              {
                dataPath: "/template/data",
                deviceTypeIdentifier: selected.deviceType,
                isAvailable: true,
                name: selected.name,
                state: "Booted",
                udid: selected.udid,
              },
            ],
          },
        });
      }),
    platform: () => "darwin",
    readApp: () => Effect.succeed(app),
    runtimes: () =>
      Effect.succeed(
        JSON.stringify({
          runtimes: [
            {
              identifier: selected.runtime,
              isAvailable: true,
              version: selected.runtimeVersion,
            },
          ],
        })
      ),
    terminate: (udid, bundleId) =>
      Effect.sync(() => {
        commands.push(["terminate", udid, bundleId]);
      }),
    xcode: () => Effect.void,
  };
  return { commands, inventoryReads, io };
};
const failureCode = <A, E extends { readonly code: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) =>
      result._tag === "Failure" ? result.failure.code : "success"
    )
  );

it.effect(
  "refuses unsupported hosts before host inventory or device commands",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands, inventoryReads } = fakeHost();
      const host = {
        ...io,
        platform: () => "linux" as const,
        xcode: () => Effect.die("must not inspect Xcode"),
      };
      expect(yield* failureCode(makeIosDiscovery(host).devices())).toBe(
        "host_unsupported"
      );
      expect(commands).toEqual([]);
      expect(inventoryReads).toEqual([]);
    })
);
it.effect(
  "refuses Intel discovery and selection before any host or device command",
  () =>
    Effect.gen(function* refuseIntel() {
      const { io, commands, inventoryReads } = fakeHost();
      const host = {
        ...io,
        architecture: () => "x64" as const,
        runtimes: () => Effect.die("must not inspect runtimes"),
        xcode: () => Effect.die("must not inspect Xcode"),
      };
      const discovery = makeIosDiscovery(host);
      expect(yield* failureCode(discovery.devices())).toBe("host_unsupported");
      expect(yield* failureCode(discovery.resolve(selected))).toBe(
        "host_unsupported"
      );
      expect(commands).toEqual([]);
      expect(inventoryReads).toEqual([]);
    })
);
it.effect(
  "refuses missing Xcode before host inventory or device commands",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands, inventoryReads } = fakeHost();
      expect(
        yield* failureCode(
          makeIosDiscovery({
            ...io,
            xcode: () => Effect.fail(iosError("xcode_missing")),
          }).devices()
        )
      ).toBe("xcode_missing");
      expect(commands).toEqual([]);
      expect(inventoryReads).toEqual([]);
    })
);
for (const [name, runtimes, code] of [
  ["missing runtime", [], "runtime_missing"],
  [
    "unavailable runtime",
    [{ identifier: selected.runtime, isAvailable: false, version: "26.5" }],
    "runtime_missing",
  ],
  [
    "old runtime",
    [{ identifier: selected.runtime, isAvailable: true, version: "25.0" }],
    "os_unsupported",
  ],
  [
    "future runtime",
    [{ identifier: selected.runtime, isAvailable: true, version: "28.0" }],
    "os_unsupported",
  ],
] as const) {
  it.effect(`refuses ${name} before device inventory or commands`, () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands, inventoryReads } = fakeHost();
      expect(
        yield* failureCode(
          makeIosDiscovery({
            ...io,
            runtimes: () => Effect.succeed(JSON.stringify({ runtimes })),
          }).devices()
        )
      ).toBe(code);
      expect(commands).toEqual([]);
      expect(inventoryReads).toEqual([]);
    })
  );
}
for (const device of [
  { ...selected, kind: "physical" },
  { ...selected, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro" },
  { ...selected, udid: "booted" },
]) {
  it.effect(
    `refuses non-iPhone selection ${device.kind} ${device.udid} ${device.deviceType}`,
    () =>
      Effect.gen(function* verifyIosBehavior() {
        const { io, commands, inventoryReads } = fakeHost();
        // SAFETY: Deliberately invalid input exercises the runtime selection guard.
        expect(
          yield* failureCode(makeIosDiscovery(io).apps(device as IosDevice))
        ).toBe(
          device.kind === "physical"
            ? "physical_device_unsupported"
            : "device_unsupported"
        );
        expect(commands).toEqual([]);
        expect(inventoryReads).toEqual([]);
      })
  );
}
it.effect(
  "refuses a selected unsupported or missing runtime before device inventory",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands, inventoryReads } = fakeHost();
      expect(
        yield* failureCode(
          makeIosDiscovery(io).apps({ ...selected, runtimeVersion: "28.0" })
        )
      ).toBe("os_unsupported");
      expect(
        yield* failureCode(
          makeIosDiscovery(io).apps({ ...selected, runtime: "missing" })
        )
      ).toBe("runtime_missing");
      expect(commands).toEqual([]);
      expect(inventoryReads).toEqual([]);
    })
);
it.effect(
  "discovers iPhones and apps without booting or modifying the selected simulator",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands } = fakeHost();
      expect(yield* makeIosDiscovery(io).devices()).toEqual([
        { ...selected, state: "Booted" },
      ]);
      expect(yield* makeIosDiscovery(io).apps(selected)).toEqual([app]);
      expect(commands).toEqual([]);
    })
);
it.effect("refuses changed identity and malformed inventory", () =>
  Effect.gen(function* verifyIosBehavior() {
    const { io, commands } = fakeHost();
    expect(
      yield* failureCode(
        makeIosDiscovery(io).apps({ ...selected, udid: other })
      )
    ).toBe("device_mismatch");
    expect(
      yield* failureCode(
        makeIosDiscovery({
          ...io,
          devices: () => Effect.succeed("{}"),
        }).devices()
      )
    ).toBe("discovery_failed");
    expect(commands).toEqual([]);
  })
);
it.effect("refuses physical devices before host or device commands", () =>
  Effect.gen(function* physicalDevice() {
    const { io, commands, inventoryReads } = fakeHost();
    const host = { ...io, xcode: () => Effect.die("must not inspect Xcode") };
    expect(
      yield* failureCode(makeIosDiscovery(host).resolve({ kind: "physical" }))
    ).toBe("physical_device_unsupported");
    expect(commands).toEqual([]);
    expect(inventoryReads).toEqual([]);
  })
);

for (const field of ["runtimeVersion", "bundleId", "build"] as const) {
  it.effect(`requires Run Environment Permission for ${field}`, () =>
    Effect.sync(() => {
      const changed = { ...environment, [field]: "changed" };
      expect(
        iosEnvironmentPermission("run", environment, changed)
      ).toMatchObject([
        {
          differences: [{ field }],
          kind: "run-environment-permission",
          runId: "run",
          targetApp: changed.bundleId,
        },
      ]);
      expect(environment[field]).not.toBe("changed");
    })
  );
}
it.effect(
  "explicit device type selection needs no environment permission",
  () =>
    Effect.sync(() => {
      const changed = { ...environment, deviceType: "another iPhone" };
      expect(compareIosEnvironments(environment, changed)).toMatchObject([
        { field: "deviceType" },
      ]);
      expect(iosEnvironmentPermission("run", environment, changed)).toEqual([]);
      expect(iosEnvironmentPermission("run", environment, environment)).toEqual(
        []
      );
    })
);

const withDirectory = <A, E>(
  run: (directory: string) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.gen(function* scopedTestDirectory() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    return yield* run(directory);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

for (const [version, supported] of [
  ["26", true],
  ["26.5", true],
  ["27.1", true],
  ["25.9", false],
  ["28", false],
  ["27beta", false],
] as const) {
  it.effect(`checks iOS ${version} support`, () =>
    Effect.gen(function* versionSupport() {
      const { io, commands } = fakeHost();
      const device = { ...selected, runtimeVersion: version };
      const host = {
        ...io,
        runtimes: () =>
          Effect.succeed(
            JSON.stringify({
              runtimes: [
                { identifier: device.runtime, isAvailable: true, version },
              ],
            })
          ),
      };
      const result = yield* failureCode(makeIosDiscovery(host).apps(device));
      expect(result).toBe(supported ? "success" : "os_unsupported");
      expect(commands).toEqual([]);
    })
  );
}

it.live(
  "refuses changed build, bundle, runtime and invalid paths before mutation",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* changedEnvironment() {
        const { io, commands } = fakeHost();
        const source = path.join(directory, "Target.app");
        yield* Effect.promise(() => mkdir(source));
        for (const changed of [
          { ...environment, build: "8" },
          { ...environment, bundleId: "other" },
          { ...environment, runtimeVersion: "27.1" },
        ]) {
          expect(
            yield* failureCode(
              Effect.scoped(
                makeIosPreparation(io).prepare({
                  appPath: source,
                  device: selected,
                  environment: changed,
                  requiredCapabilities: [],
                })
              )
            )
          ).toBe("environment_changed");
        }
        expect(
          yield* failureCode(
            Effect.scoped(
              makeIosPreparation(io).prepare({
                appPath: "relative.app",
                device: selected,
                environment,
                requiredCapabilities: [],
              })
            )
          )
        ).toBe("preparation_failed");
        expect(commands).toEqual([]);
      })
    )
);

it.effect(
  "keeps daemon stop isolated without the unsupported session flag",
  () =>
    Effect.sync(() => {
      const args = iosRunnerArguments("/private/session-state", session, [
        "daemon",
        "stop",
      ]);
      expect(args).toContain("--state-dir");
      expect(args).toContain("/private/session-state");
      expect(args).not.toContain("--session");
      expect(
        iosRunnerArguments("/private/session-state", session, [
          "prepare",
          "ios-runner",
        ])
      ).toContain(`contingency-ios-${session}`);
    })
);

it.effect(
  "lists stopped simulators but refuses apps and preparation without booting",
  () =>
    Effect.gen(function* stoppedSelection() {
      const { io, commands } = fakeHost();
      const host = {
        ...io,
        devices: () =>
          io
            .devices()
            .pipe(Effect.map((text) => text.replaceAll("Booted", "Shutdown"))),
      };
      expect(yield* makeIosDiscovery(host).devices()).toEqual([
        { ...selected, state: "Shutdown" },
      ]);
      expect(yield* failureCode(makeIosDiscovery(host).apps(selected))).toBe(
        "device_stopped"
      );
      expect(
        yield* failureCode(
          Effect.scoped(
            makeIosPreparation(host).prepare({
              device: selected,
              environment,
              requiredCapabilities: [],
            })
          )
        )
      ).toBe("device_stopped");
      expect(commands).toEqual([]);
    })
);

for (const install of [false, true]) {
  for (const outcome of [
    "success",
    "launch",
    "runner",
    "interruption",
  ] as const) {
    it.effect(
      `binds the selected simulator with install=${install} after ${outcome}`,
      () =>
        withDirectory((directory) =>
          Effect.gen(function* selectedLifecycle() {
            const { io, commands } = fakeHost();
            const source = path.join(directory, "Target.app");
            yield* Effect.promise(() => mkdir(source));
            yield* Effect.promise(() =>
              writeFile(path.join(source, "sentinel"), "existing data")
            );
            const host = {
              ...io,
              device: (args: readonly string[]) =>
                io
                  .device(args)
                  .pipe(
                    Effect.andThen((result) =>
                      args[0] === outcome
                        ? Effect.fail(iosError("preparation_failed"))
                        : Effect.succeed(result)
                    )
                  ),
              readApp: (bundle: string) =>
                Effect.succeed({ ...app, path: bundle }),
            };
            const stopped: string[] = [];
            const ready = yield* Deferred.make<boolean>();
            const service = makeIosPreparation(
              host,
              () =>
                outcome === "runner"
                  ? Effect.fail(iosError("preparation_failed"))
                  : Effect.void,
              (owned, udid) =>
                Effect.sync(() => {
                  stopped.push(udid);
                  expect(owned).toContain("contingency-ios-");
                })
            );
            const base: IosPreparationInput = {
              device: selected,
              environment,
              requiredCapabilities: [],
            };
            const input = install ? { ...base, appPath: source } : base;
            const run = Effect.scoped(
              Effect.gen(function* sessionUse() {
                const prepared = yield* service.prepare(input);
                expect(prepared.device).toEqual(selected);
                yield* Deferred.succeed(ready, true);
                if (outcome === "interruption") {
                  yield* Effect.never;
                }
              })
            );
            if (outcome === "interruption") {
              const fiber = yield* Effect.forkChild(run);
              yield* Deferred.await(ready);
              yield* Fiber.interrupt(fiber);
            } else {
              expect(Exit.isSuccess(yield* Effect.exit(run))).toBe(
                outcome === "success"
              );
            }
            expect(stopped).toEqual([selected.udid]);
            expect(commands.map(([command]) => command)).toEqual([
              ...(install ? ["install"] : []),
              "terminate",
              "launch",
            ]);
            expect(commands.every((args) => args[1] === selected.udid)).toBe(
              true
            );
            expect(
              yield* Effect.promise(() =>
                readFile(path.join(source, "sentinel"), "utf-8")
              )
            ).toBe("existing data");
          })
        )
    );
  }
}

for (const install of [false, true]) {
  it.effect(
    `applies declared permission states before launch with install=${install}`,
    () =>
      withDirectory((directory) =>
        Effect.gen(function* permissionPreparation() {
          const { io, commands } = fakeHost();
          const source = path.join(directory, "Target.app");
          yield* Effect.promise(() => mkdir(source));
          const host = {
            ...io,
            readApp: (bundle: string) =>
              Effect.succeed({ ...app, path: bundle }),
          };
          const base: IosPreparationInput = {
            device: selected,
            environment: {
              ...environment,
              permissions: [
                { decision: "revoke", service: "location" },
                { decision: "grant", service: "photos" },
                { decision: "reset", service: "contacts" },
              ],
            },
            requiredCapabilities: [],
          };
          yield* Effect.scoped(
            makeIosPreparation(
              host,
              () => Effect.void,
              () => Effect.void
            ).prepare(install ? { ...base, appPath: source } : base)
          );
          const { udid } = selected;
          const { bundleId } = environment;
          expect(commands.filter(([command]) => command !== "install")).toEqual(
            [
              ["terminate", udid, bundleId],
              ["privacy", udid, "revoke", "location", bundleId],
              ["privacy", udid, "grant", "photos", bundleId],
              ["privacy", udid, "reset", "contacts", bundleId],
              ["launch", udid, bundleId],
            ]
          );
          expect(commands.map(([command]) => command)).toEqual([
            ...(install ? ["install"] : []),
            "terminate",
            "privacy",
            "privacy",
            "privacy",
            "launch",
          ]);
        })
      )
  );
}

for (const permissions of [
  [{ decision: "revoke", service: "notifications" }],
  [{ decision: "grant", service: "all" }],
  [
    { decision: "grant", service: "photos" },
    { decision: "revoke", service: "photos" },
  ],
] as const) {
  it.effect(
    `refuses ${JSON.stringify(permissions)} before inventory or device commands`,
    () =>
      Effect.gen(function* unsupportedPermission() {
        const { io, commands, inventoryReads } = fakeHost();
        expect(
          yield* failureCode(
            Effect.scoped(
              makeIosPreparation(io).prepare({
                device: selected,
                environment: { ...environment, permissions },
                requiredCapabilities: [],
              })
            )
          )
        ).toBe("permission_service_unsupported");
        expect(commands).toEqual([]);
        expect(inventoryReads).toEqual([]);
      })
  );
}

it.effect("declared permission states are part of the taught environment", () =>
  Effect.sync(() => {
    const declared = {
      ...environment,
      permissions: [{ decision: "revoke", service: "location" }] as const,
    };
    expect(compareIosEnvironments(environment, declared)).toEqual([
      {
        field: "permissions",
        selected: JSON.stringify(declared.permissions),
        taught: "[]",
      },
    ]);
    expect(
      iosEnvironmentPermission("run", environment, declared)
    ).toMatchObject([
      {
        differences: [{ field: "permissions" }],
        kind: "run-environment-permission",
      },
    ]);
    expect(compareIosEnvironments(declared, declared)).toEqual([]);
  })
);
