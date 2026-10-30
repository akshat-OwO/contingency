import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Cause } from "effect";
import {
  Console,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { verifyIosFramebufferRelease } from "../../cli/src/services/ios-framebuffer-release.ts";
import { runInstallCheckCommand } from "./verify-cli-install.ts";

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
const Uuid = Schema.String.check(Schema.isPattern(uuid));
const DeviceType = Schema.Struct({
  identifier: Schema.String,
  name: Schema.String,
});
const RuntimeInventory = Schema.fromJsonString(
  Schema.Struct({
    runtimes: Schema.Array(
      Schema.Struct({
        identifier: Schema.String,
        isAvailable: Schema.Boolean,
        name: Schema.String,
        supportedDeviceTypes: Schema.Array(DeviceType),
        version: Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)*$/u)),
      })
    ),
  })
);

const DeviceInventory = Schema.fromJsonString(
  Schema.Struct({
    devices: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ state: Schema.String, udid: Schema.String }))
    ),
  })
);

/** True only when this exact simulator reports Booted; unknown UDIDs fail. */
export const simulatorBooted = (output: string, udid: string) => {
  const { devices } = Schema.decodeUnknownSync(DeviceInventory)(output);
  const device = Object.values(devices)
    .flat()
    .find((item) => item.udid === udid);
  if (!device) {
    throw new Error(`Simulator ${udid} is missing from the inventory`);
  }
  return device.state === "Booted";
};

/** Numeric version ordering, independent of simctl's inventory order. */
export const selectIosRuntime = (output: string) => {
  const { runtimes } = Schema.decodeUnknownSync(RuntimeInventory)(output);
  const [runtime] = runtimes
    .filter(
      (item) =>
        item.isAvailable &&
        item.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-")
    )
    .toSorted((left, right) =>
      right.version.localeCompare(left.version, "en", { numeric: true })
    );
  const device = runtime?.supportedDeviceTypes.find((item) =>
    item.name.startsWith("iPhone")
  );
  if (!runtime || !device) {
    throw new Error("Newest available iOS runtime must support an iPhone");
  }
  return { device, runtime };
};

/** Prefer the explicitly named primary integrated panel on multi-panel iPhones. */
export const parseIntegratedDisplay = (output: string): string => {
  const inventory = output.replaceAll("\r\n", "\n");
  const candidates = inventory
    .split(/(?:^|\n)Port:\n/u)
    .filter(
      (port) =>
        /Port Identifier: com\.apple\.framebuffer\.display\n/u.test(port) &&
        /Display class: 0\n/u.test(port) &&
        /Power state: On\n/u.test(port) &&
        /IOSurface port:/u.test(port)
    );
  const primaryScreens = inventory
    .split(/\n\s*\(\d+\) [^\r\n]+:\n/u)
    .filter(
      (screen) =>
        /Screen Type: Integrated\n/u.test(screen) &&
        /Device Name: primary\n/u.test(screen)
    );
  const size =
    primaryScreens.length === 1
      ? /Pixel Size: \{(?<width>\d+), (?<height>\d+)\}/u.exec(
          primaryScreens[0] ?? ""
        )?.groups
      : undefined;
  const ports =
    candidates.length <= 1
      ? candidates
      : candidates.filter(
          (port) =>
            size !== undefined &&
            /Default width: (?<width>\d+)/u.exec(port)?.groups?.width ===
              size.width &&
            /Default height: (?<height>\d+)/u.exec(port)?.groups?.height ===
              size.height
        );
  const id = /UUID: (?<id>[a-f\d-]{36})/iu.exec(ports[0] ?? "")?.groups?.id;
  if (ports.length !== 1 || !id || !uuid.test(id)) {
    throw new Error("Expected exactly one integrated IOSurface display port");
  }
  return id;
};

const Packet = Schema.fromJsonString(
  Schema.Struct({
    displayPort: Uuid,
    height: Schema.Int.check(Schema.isGreaterThan(0)),
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    sourceSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    width: Schema.Int.check(Schema.isGreaterThan(0)),
  })
);
export const validateHelperPacket = (
  line: string,
  display: string,
  previous: number
) => {
  const packet = Schema.decodeUnknownSync(Packet)(line);
  if (
    packet.sequence <= previous ||
    packet.displayPort.toLowerCase() !== display.toLowerCase()
  ) {
    throw new Error(
      "Helper packet has a repeated/decreasing sequence or wrong display"
    );
  }
  return packet;
};

/** sample's code-type spelling changed in newer macOS releases. */
export const validateHelperArchitecture = (
  sample: string,
  pid: number,
  architecture: string
) => {
  const codeType = /Code Type:\s*(?<type>[^\n]+)/u
    .exec(sample)
    ?.groups?.type?.trim();
  const sampledProcess = /Process:\s*(?<name>[^\n]+)/u
    .exec(sample)
    ?.groups?.name?.trim();
  const nativeType = /^(?:ARM64|ARM-64)(?: \(Native\))?$/u;
  if (
    !codeType ||
    !nativeType.test(codeType) ||
    sampledProcess !== `framebuffer [${pid}]` ||
    architecture !== "arm64"
  ) {
    throw new Error(
      `Sampled process ${sampledProcess}, architecture ${codeType}; expected native ${architecture} framebuffer [${pid}]`
    );
  }
  return { codeType, sampledProcess };
};

const parse = <A>(f: () => A) =>
  Effect.try({
    catch: (cause) => new Error("Invalid iOS helper proof data", { cause }),
    try: f,
  });

const streamHelper = Effect.fn("streamInstalledIosHelper")(function* stream(
  helper: string,
  developer: string,
  udid: string,
  display: string,
  directory: string
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // arch selects the expected slice explicitly. sample below observes the actual
  // helper process, including whether Rosetta translated it.
  const child = yield* spawner.spawn(
    ChildProcess.make(
      "/usr/bin/arch",
      ["-arm64", helper, developer, udid, display, "portrait"],
      { cwd: directory, stderr: "inherit" }
    )
  );
  yield* Console.log(
    JSON.stringify({
      helperPid: child.pid,
      owner: "verify-ios-helper",
      ports: [],
      startedAt: new Date().toISOString(),
      stop: "stop + EOF; scoped child termination on failure",
    })
  );
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const writer = yield* Stream.fromQueue(input).pipe(
    Stream.run(child.stdin),
    Effect.forkScoped
  );
  const send = (command: string) =>
    Queue.offer(input, new TextEncoder().encode(`${command}\n`));
  yield* send("start");
  let sequence = 0;
  let count = 0;
  const ready = yield* Deferred.make<boolean>();
  const reader = yield* child.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.gen(function* packet() {
        const value = yield* parse(() =>
          validateHelperPacket(line, display, sequence)
        );
        ({ sequence } = value);
        count += 1;
        if (count <= 3) {
          yield* Console.log(JSON.stringify(value));
        }
        if (count === 3) {
          yield* Deferred.succeed(ready, true);
        }
      })
    ),
    Effect.forkScoped
  );
  yield* Effect.raceFirst(
    Deferred.await(ready),
    Fiber.join(reader).pipe(
      Effect.andThen(
        Effect.fail(new Error("Helper ended before three packets"))
      )
    )
  ).pipe(Effect.timeout("60 seconds"));
  const sampleFile = path.join(directory, "helper.sample.txt");
  yield* runInstallCheckCommand(
    "/usr/bin/sample",
    [String(child.pid), "1", "1", "-file", sampleFile],
    directory
  );
  const sample = yield* fs.readFileString(sampleFile);
  const { codeType, sampledProcess } = yield* parse(() =>
    validateHelperArchitecture(sample, child.pid, "arm64")
  );
  yield* Console.log(
    JSON.stringify({ codeType, helperPid: child.pid, sampledProcess })
  );
  yield* send("stop");
  yield* Queue.end(input);
  yield* Fiber.join(writer);
  const exit = yield* child.exitCode.pipe(Effect.timeout("30 seconds"));
  if (exit !== 0) {
    return yield* Effect.fail(new Error(`Installed helper exited ${exit}`));
  }
  yield* Fiber.join(reader);
  yield* Console.log(
    "Installed helper passed: 3 increasing packets, stop, exit 0."
  );
}, Effect.scoped);

/** The install is isolated; simctl uses the runner's normal CoreSimulator set. */
export const verifyIosHelper = Effect.fn("verifyIosHelper")(function* verify(
  tarball: string
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "contingency-ios-clean-host-",
  });
  const run = (command: string, args: readonly string[]) =>
    runInstallCheckCommand(command, args, directory);
  // CoreSimulator starts on demand; a cold hosted runner can take minutes to answer.
  const simctl = (args: readonly string[]) =>
    runInstallCheckCommand(
      "xcrun",
      ["simctl", ...args],
      directory,
      {},
      "5 minutes"
    );
  const host = (yield* run("uname", ["-m"])).stdout.trim();
  const translated =
    (yield* run("sysctl", ["-in", "sysctl.proc_translated"])).stdout.trim() ||
    "0";
  yield* Console.log(
    JSON.stringify({ expectedArchitecture: "arm64", host, translated })
  );
  if (
    process.platform !== "darwin" ||
    host !== "arm64" ||
    translated !== "0" ||
    process.arch !== "arm64"
  ) {
    return yield* Effect.fail(
      new Error("Proof requires the expected native Mac architecture")
    );
  }
  const home = path.join(directory, "home");
  const prefix = path.join(directory, "prefix");
  yield* fs.makeDirectory(home);
  yield* fs.makeDirectory(prefix);
  yield* runInstallCheckCommand(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--offline",
      "--strict-peer-deps",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(directory, "cache"),
      path.resolve(tarball),
    ],
    prefix,
    {
      HOME: home,
      NPM_CONFIG_GLOBALCONFIG: path.join(home, "global.npmrc"),
      NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    }
  );
  const release = path.join(
    prefix,
    "node_modules/@contingencyhq/cli/dist/ios/framebuffer"
  );
  const helper = yield* verifyIosFramebufferRelease(release);
  yield* Console.log((yield* run("lipo", ["-info", helper])).stdout.trim());
  const slices = (yield* run("lipo", ["-archs", helper])).stdout.trim();
  if (slices !== "arm64") {
    return yield* Effect.fail(
      new Error("Installed helper must contain only arm64")
    );
  }
  yield* run("codesign", ["-v", "--strict", "--all-architectures", helper]);
  const attributes = (yield* run("xattr", [helper])).stdout;
  if (attributes.split("\n").includes("com.apple.quarantine")) {
    return yield* Effect.fail(
      new Error("Installed helper has a quarantine attribute")
    );
  }
  yield* Console.log(
    "Installed arm64 helper passed runtime manifest, codesign, and quarantine checks."
  );
  const inventory = (yield* simctl(["list", "runtimes", "--json"])).stdout;
  const { runtime, device } = yield* parse(() => selectIosRuntime(inventory));
  yield* Console.log(
    JSON.stringify({
      device: device.identifier,
      runtime: runtime.identifier,
      version: runtime.version,
    })
  );
  const udid = yield* Effect.acquireRelease(
    simctl([
      "create",
      `contingency-clean-host-${randomUUID()}`,
      device.identifier,
      runtime.identifier,
    ]).pipe(
      Effect.flatMap(({ stdout }) =>
        parse(() => Schema.decodeUnknownSync(Uuid)(stdout.trim()))
      )
    ),
    (id) =>
      simctl(["delete", id]).pipe(
        Effect.andThen(Console.log(`Deleted proof-owned simulator ${id}`)),
        Effect.orDie
      )
  );
  yield* Console.log(
    JSON.stringify({
      owner: "verify-ios-helper",
      simulatorUdid: udid,
      startedAt: new Date().toISOString(),
      stop: `xcrun simctl delete ${udid}`,
    })
  );
  yield* simctl(["boot", udid]);
  // The helper needs only the display. Waiting for bootstatus can stall on a
  // slow hosted runner's data migration, so poll the device state instead.
  yield* run("xcrun", ["simctl", "list", "devices", "--json"]).pipe(
    Effect.flatMap(({ stdout }) => parse(() => simulatorBooted(stdout, udid))),
    Effect.flatMap((booted) =>
      booted
        ? Effect.void
        : Effect.fail(new Error(`Simulator ${udid} is not booted yet`))
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
    // One deadline for the whole wait, however each poll ends.
    Effect.timeout("6 minutes")
  );
  yield* Console.log(JSON.stringify({ booted: udid }));
  // A fresh hosted runner's first boot can report a terminal status before its
  // display service answers, so enumerate again within a bound.
  const display = yield* run("xcrun", ["simctl", "io", udid, "enumerate"]).pipe(
    Effect.tap(({ stdout }) => Console.log(stdout)),
    Effect.flatMap(({ stdout }) => parse(() => parseIntegratedDisplay(stdout))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 4 })
  );
  const developer = (yield* run("xcode-select", ["-p"])).stdout.trim();
  yield* streamHelper(helper, developer, udid, display, directory);
}, Effect.scoped);
