import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Scope } from "effect";

import { hostProcessIsAlive } from "../../src/services/agent-session-resources.ts";
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
import { makeIosSessionResources } from "../../src/services/ios-session-resources.ts";
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
  let sessionExists = false;
  const io: IosSimctlService = {
    apps: () => Effect.succeed([app]),
    device: (args) =>
      Effect.sync(() => {
        commands.push([...args]);
        if (args[0] === "create") {
          sessionExists = true;
        }
        if (args[0] === "delete") {
          sessionExists = false;
        }
        return args[0] === "create" ? session : "";
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
                udid: selected.udid,
              },
              {
                dataPath: "/session/data",
                deviceTypeIdentifier: selected.deviceType,
                isAvailable: sessionExists,
                name: "Session",
                udid: session,
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
        ).toBe("device_unsupported");
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
  "discovers iPhones and apps without booting or modifying the template",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands } = fakeHost();
      expect(yield* makeIosDiscovery(io).devices()).toEqual([selected]);
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
it.effect(
  "refuses Private Variables before any device command or value resolution",
  () =>
    Effect.gen(function* verifyIosBehavior() {
      const { io, commands, inventoryReads } = fakeHost();
      expect(
        yield* failureCode(
          Effect.scoped(
            makeIosPreparation(io).prepare({
              device: selected,
              environment,
              requiredCapabilities: ["private-input"],
            })
          )
        )
      ).toBe("capability_missing");
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

for (const outcome of [
  "success",
  "boot",
  "install",
  "runner",
  "interruption",
] as const) {
  it.live(
    `releases the recorded Session Simulator after ${outcome} and leaves template unchanged`,
    () =>
      withDirectory((directory) =>
        Effect.gen(function* verifyIosBehavior() {
          const { io, commands } = fakeHost();
          const source = path.join(directory, "Source.app");
          yield* Effect.promise(() => mkdir(source));
          yield* Effect.promise(() =>
            writeFile(
              path.join(source, "sentinel"),
              "unchanged template bundle"
            )
          );
          const records = path.join(directory, "records");
          const host = {
            ...io,
            apps: (dataPath: string) =>
              Effect.sync(() => {
                expect(dataPath).toBe("/template/data");
                expect(commands).toEqual([]);
                return [{ ...app, path: source }];
              }),
            device: (args: readonly string[]) =>
              Effect.gen(function* device() {
                if (args[0] === "boot") {
                  expect(
                    JSON.parse(
                      yield* Effect.promise(() =>
                        readFile(path.join(records, `${session}.json`), "utf-8")
                      )
                    )
                  ).toMatchObject({ owner: process.pid, udid: session });
                }
                const result = yield* io.device(args);
                if (args[0] === outcome) {
                  return yield* Effect.fail(iosError("preparation_failed"));
                }
                return result;
              }),
            readApp: (bundle: string) =>
              Effect.gen(function* validateCopiedBundle() {
                expect(bundle).not.toBe(source);
                expect(commands).toEqual([]);
                expect(
                  yield* Effect.promise(() =>
                    readFile(path.join(bundle, "sentinel"), "utf-8")
                  )
                ).toBe("unchanged template bundle");
                return { ...app, path: bundle };
              }),
          };
          const runner = () =>
            outcome === "runner"
              ? Effect.fail(iosError("preparation_failed"))
              : Effect.void;
          const service = makeIosPreparation(
            host,
            makeIosSessionResources(records, host),
            runner
          );
          const input: IosPreparationInput = {
            device: selected,
            environment,
            requiredCapabilities: [],
          };
          const request =
            outcome === "success" ? { ...input, appPath: source } : input;
          const scope = yield* Scope.make();
          const prepared = yield* Effect.result(
            service.prepare(request).pipe(Scope.provide(scope))
          );
          if (outcome === "interruption") {
            // Interrupt use after acquisition; closing its scope owns all finalization.
            yield* Effect.scoped(
              Effect.gen(function* interruptSession() {
                yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
                return yield* Effect.interrupt;
              })
            ).pipe(Effect.exit);
          }
          yield* Scope.close(scope, Exit.void);
          expect(prepared._tag).toBe(
            outcome === "boot" || outcome === "install" || outcome === "runner"
              ? "Failure"
              : "Success"
          );
          expect(commands.at(-1)).toEqual(["delete", session]);
          expect(
            commands
              .filter(([command]) => command !== "create")
              .every((args) => args[1] === session)
          ).toBe(true);
          expect(yield* Effect.promise(() => readdir(records))).toEqual([]);
          expect(
            yield* Effect.promise(() =>
              readFile(path.join(source, "sentinel"), "utf-8")
            )
          ).toBe("unchanged template bundle");
          if (outcome === "success") {
            expect(commands.map(([command]) => command)).toEqual([
              "create",
              "boot",
              "bootstatus",
              "install",
              "delete",
            ]);
            expect(commands[0]).toEqual([
              "create",
              expect.stringMatching(/^Contingency /u),
              selected.deviceType,
              selected.runtime,
            ]);
          }
        })
      )
  );
}

it.live(
  "scavenges only recorded dead owners, sparing live owners and unrelated simulators",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* verifyIosBehavior() {
        const { io, commands } = fakeHost();
        const resources = makeIosSessionResources(
          directory,
          io,
          (pid) => pid === process.pid
        );
        yield* resources.record(session, 40_101);
        yield* resources.record(other);
        yield* Effect.promise(() =>
          writeFile(
            path.join(directory, `${selected.udid}.json`),
            JSON.stringify({ owner: 40_101, udid: session })
          )
        );
        yield* Effect.promise(() =>
          writeFile(path.join(directory, "Contingency session.json"), "{}")
        );
        yield* resources.cleanup();
        expect(commands).toEqual([["delete", session]]);
        expect(yield* Effect.promise(() => readdir(directory))).toContain(
          `${other}.json`
        );
      })
    )
);

it.live(
  "tolerates another startup reclaiming the same dead owner's Session Simulator first",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* verifyIosBehavior() {
        const first = fakeHost();
        const second = fakeHost();
        const checking = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        // The second startup has parsed the record and is checking the host.
        const held: IosSimctlService = {
          ...second.io,
          xcode: () =>
            Deferred.succeed(checking, true).pipe(
              Effect.andThen(Deferred.await(release))
            ),
        };
        yield* makeIosSessionResources(directory, first.io, () => false).record(
          session,
          40_101
        );
        const late = yield* Effect.forkChild(
          makeIosSessionResources(directory, held, () => false).cleanup()
        );
        yield* Deferred.await(checking);
        yield* makeIosSessionResources(
          directory,
          first.io,
          () => false
        ).cleanup();
        yield* Deferred.succeed(release, true);
        expect(Exit.isSuccess(yield* Fiber.await(late))).toBe(true);
        expect(first.commands).toEqual([["delete", session]]);
        expect(second.commands).toEqual([]);
        expect(yield* Effect.promise(() => readdir(directory))).toEqual([]);
      })
    )
);

it.live(
  "reclaims a SIGKILLed owner's Session Simulator on the next startup and spares a live owner",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* verifyIosBehavior() {
        const { io, commands } = fakeHost();
        const child = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const process = spawn(
              globalThis.process.execPath,
              ["-e", "process.stdin.resume()"],
              { stdio: ["pipe", "ignore", "ignore"] }
            );
            await once(process, "spawn");
            return process;
          }),
          (process) =>
            Effect.promise(async () => {
              if (process.exitCode === null && process.signalCode === null) {
                const exit = once(process, "exit");
                process.kill("SIGKILL");
                await exit;
              }
            })
        );
        expect(child.pid).toBeDefined();
        const resources = makeIosSessionResources(directory, io);
        yield* resources.record(session, child.pid);
        yield* resources.record(other);
        expect(hostProcessIsAlive(child.pid ?? 0)).toBe(true);
        yield* resources.cleanup();
        expect(commands).toEqual([]);
        yield* Effect.promise(async () => {
          const exit = once(child, "exit");
          child.kill("SIGKILL");
          await exit;
        });
        expect(hostProcessIsAlive(child.pid ?? 0)).toBe(false);
        yield* makeIosSessionResources(directory, io).cleanup();
        expect(commands).toEqual([["delete", session]]);
        expect(yield* Effect.promise(() => readdir(directory))).toEqual([
          `${other}.json`,
        ]);
      })
    ).pipe(Effect.timeout("30 seconds"))
);

it.live(
  "interruption while waiting for boot deletes the Session Simulator",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* interruptBoot() {
        const { io, commands } = fakeHost();
        const source = path.join(directory, "Target.app");
        yield* Effect.promise(() => mkdir(source));
        const booting = yield* Deferred.make<boolean>();
        const host = {
          ...io,
          apps: () => Effect.succeed([{ ...app, path: source }]),
          device: (args: readonly string[]) =>
            io
              .device(args)
              .pipe(
                Effect.andThen((result) =>
                  args[0] === "bootstatus"
                    ? Deferred.succeed(booting, true).pipe(
                        Effect.andThen(Effect.never)
                      )
                    : Effect.succeed(result)
                )
              ),
        };
        const records = path.join(directory, "records");
        const fiber = yield* Effect.scoped(
          makeIosPreparation(
            host,
            makeIosSessionResources(records, host),
            () => Effect.void
          ).prepare({
            appPath: source,
            device: selected,
            environment,
            requiredCapabilities: [],
          })
        ).pipe(Effect.forkChild);
        yield* Deferred.await(booting);
        yield* Fiber.interrupt(fiber);
        expect(commands.at(-1)).toEqual(["delete", session]);
        expect(yield* Effect.promise(() => readdir(records))).toEqual([]);
      })
    ).pipe(Effect.timeout("30 seconds"))
);

it.live(
  "retains ownership when deletion fails and retries on next startup",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* retryDeletion() {
        const { io, commands } = fakeHost();
        const host = {
          ...io,
          device: () => Effect.fail(iosError("preparation_failed")),
          devices: () =>
            Effect.succeed(
              JSON.stringify({ devices: { runtime: [{ udid: session }] } })
            ),
        };
        const resources = makeIosSessionResources(directory, host, () => false);
        yield* resources.record(session, 40_101);
        expect(yield* failureCode(resources.cleanup())).toBe("cleanup_failed");
        expect(yield* Effect.promise(() => readdir(directory))).toEqual([
          `${session}.json`,
        ]);
        yield* makeIosSessionResources(directory, io, () => false).cleanup();
        expect(commands).toEqual([["delete", session]]);
        expect(yield* Effect.promise(() => readdir(directory))).toEqual([]);
      })
    )
);

it.live(
  "does not issue a delete without a matching valid ownership record",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* noUnrecordedDeletion() {
        const { io, commands } = fakeHost();
        const resources = makeIosSessionResources(directory, io);
        expect(yield* failureCode(resources.remove(selected.udid))).toBe(
          "cleanup_failed"
        );
        expect(yield* failureCode(resources.remove("booted"))).toBe(
          "cleanup_failed"
        );
        expect(commands).toEqual([]);
      })
    )
);

it.live(
  "deletes a new Session Simulator if recording fails, without booting it",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* recordFailure() {
        const { io, commands } = fakeHost();
        const source = path.join(directory, "Target.app");
        yield* Effect.promise(() => mkdir(source));
        const resources = makeIosSessionResources(
          path.join(directory, "records"),
          io
        );
        const service = makeIosPreparation(
          io,
          {
            ...resources,
            record: () => Effect.fail(iosError("cleanup_failed")),
          },
          () => Effect.void
        );
        expect(
          yield* failureCode(
            Effect.scoped(
              service.prepare({
                appPath: source,
                device: selected,
                environment,
                requiredCapabilities: [],
              })
            )
          )
        ).toBe("cleanup_failed");
        expect(commands.map(([command]) => command)).toEqual([
          "create",
          "delete",
        ]);
      })
    )
);

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
  "refuses changed build, bundle, runtime and invalid paths before cloning",
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

it.live(
  "stops the owned runner before deletion and retains all state if stopping fails",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* runnerCleanupFailure() {
        const { io, commands } = fakeHost();
        const state = yield* Effect.acquireRelease(
          Effect.promise(() =>
            mkdtemp(path.join(tmpdir(), "contingency-ios-test-"))
          ),
          (owned) =>
            Effect.promise(() => rm(owned, { force: true, recursive: true }))
        );
        const stopCalls: string[] = [];
        const resources = makeIosSessionResources(
          directory,
          io,
          () => false,
          () =>
            Effect.gen(function* failedStop() {
              stopCalls.push("stop");
              return yield* Effect.fail(iosError("cleanup_failed"));
            })
        );
        yield* resources.record(session, 40_101, state);
        expect(yield* resources.isRecorded(state)).toBe(true);
        expect(yield* failureCode(resources.cleanup())).toBe("cleanup_failed");
        expect(commands).toEqual([]);
        expect(stopCalls).toEqual(["stop"]);
        expect(yield* resources.isRecorded(state)).toBe(true);
        yield* makeIosSessionResources(
          directory,
          io,
          () => false,
          () =>
            Effect.sync(() => {
              expect(commands).toEqual([]);
              stopCalls.push("stopped");
            })
        ).cleanup();
        expect(commands).toEqual([["delete", session]]);
        expect(stopCalls).toEqual(["stop", "stopped"]);
        expect(yield* resources.isRecorded(state)).toBe(false);
      })
    )
);

it.effect("lists only available iPhone simulators", () =>
  Effect.gen(function* inventoryFiltering() {
    const { io, commands } = fakeHost();
    const entries = [
      {
        dataPath: "/data",
        deviceTypeIdentifier: selected.deviceType,
        isAvailable: true,
        name: selected.name,
        udid: selected.udid,
      },
      {
        dataPath: "/data",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro",
        isAvailable: true,
        name: "iPad",
        udid: other,
      },
      {
        dataPath: "/data",
        deviceTypeIdentifier: selected.deviceType,
        isAvailable: false,
        name: "Unavailable",
        udid: session,
      },
    ];
    const discovery = makeIosDiscovery({
      ...io,
      devices: () =>
        Effect.succeed(
          JSON.stringify({ devices: { [selected.runtime]: entries } })
        ),
    });
    expect(yield* discovery.devices()).toEqual([selected]);
    expect(commands).toEqual([]);
  })
);

it.live(
  "retains Session Simulator and daemon state when a scoped deletion fails",
  () =>
    withDirectory((directory) =>
      Effect.gen(function* failedFinalizer() {
        const { io } = fakeHost();
        const source = path.join(directory, "Target.app");
        yield* Effect.promise(() => mkdir(source));
        const host = {
          ...io,
          device: (args: readonly string[]) =>
            args[0] === "delete"
              ? Effect.fail(iosError("cleanup_failed"))
              : io.device(args),
          devices: () =>
            Effect.succeed(
              JSON.stringify({
                devices: {
                  [selected.runtime]: [
                    {
                      dataPath: "/template/data",
                      deviceTypeIdentifier: selected.deviceType,
                      isAvailable: true,
                      name: selected.name,
                      udid: selected.udid,
                    },
                    {
                      dataPath: "/session/data",
                      deviceTypeIdentifier: selected.deviceType,
                      isAvailable: true,
                      name: "Session",
                      udid: session,
                    },
                  ],
                },
              })
            ),
        };
        const records = path.join(directory, "records");
        const resources = makeIosSessionResources(records, host);
        const result = yield* Effect.scoped(
          makeIosPreparation(host, resources, () => Effect.void).prepare({
            appPath: source,
            device: selected,
            environment,
            requiredCapabilities: [],
          })
        ).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        const record = JSON.parse(
          yield* Effect.promise(() =>
            readFile(path.join(records, `${session}.json`), "utf-8")
          )
        );
        expect(yield* resources.isRecorded(record.directory)).toBe(true);
        expect(
          yield* Effect.promise(() => readdir(record.directory))
        ).toContain("Target.app");
        yield* makeIosSessionResources(records, io, () => false).cleanup();
        expect(yield* resources.isRecorded(record.directory)).toBe(false);
      })
    )
);
