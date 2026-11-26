import { EventEmitter, once } from "node:events";

import { expect, it } from "vitest";

import { startEmulator } from "../../../../.cursor/skills/verify-contingency/bin/native-capture-emulator.mjs";

const OWNED_PID = 4242;

// A launcher that never starts a process: it records the emulator the proof
// asked for and exits it only when something stops that exact PID.
const harness = ({
  bootShell,
  emuKill = () => Promise.resolve(),
  apkInstall,
}) => {
  const calls = [];
  const signals = [];
  // oxlint-disable-next-line unicorn/prefer-event-target -- A ChildProcess is an EventEmitter, and the code under test listens for its `exit` event.
  const emulator = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: OWNED_PID,
    signalCode: null,
  });
  const execute = (command, args, options) => {
    calls.push(args.join(" "));
    if (args[0] === "devices") {
      return Promise.resolve({ stdout: "List of devices attached\n" });
    }
    const [, serial, ...rest] = args;
    if (rest[0] === "emu") {
      return emuKill(serial, emulator);
    }
    if (rest[0] === "install") {
      return apkInstall?.() ?? Promise.resolve({ stdout: "" });
    }
    if (rest[0] === "shell") {
      return bootShell(options);
    }
    return Promise.resolve({ stdout: "" });
  };
  const launches = [];
  return {
    calls,
    emulator,
    launches,
    signals,
    start: (overrides = {}) =>
      startEmulator({
        adb: "adb",
        avd: "proof_avd",
        emulatorBinary: "emulator",
        execute,
        graceMs: 1,
        killGroup: (pid, signal) => {
          signals.push([pid, signal]);
          emulator.signalCode = signal;
          emulator.emit("exit", null, signal);
        },
        port: 5590,
        spawn: (binary, args, options) => {
          launches.push({ args, binary, options });
          return emulator;
        },
        ...overrides,
      }),
  };
};

const hangUntilAborted = async ({ signal }) => {
  await once(signal, "abort");
  throw signal.reason;
};

const bootedShell = () => Promise.resolve({ stdout: "1\n" });

const offlineShell = () =>
  Promise.reject(
    Object.assign(new Error("adb: device offline"), { code: 255 })
  );

it("stops the emulator it launched when the boot wait fails", async () => {
  const proof = harness({
    bootShell: offlineShell,
    emuKill: () => Promise.reject(new Error("adb: device offline")),
  });
  const tracked = [];

  await expect(
    proof.start({
      bootTimeoutMs: 1,
      pollMs: 0,
      track: (cleanup) => tracked.push(cleanup),
    })
  ).rejects.toThrow();

  expect(tracked).toHaveLength(1);
  expect(proof.launches[0].options.detached).toBe(true);
  expect(proof.signals).toEqual([[OWNED_PID, "SIGTERM"]]);
  expect(proof.emulator.signalCode).toBe("SIGTERM");
  expect(proof.calls.filter((call) => call.includes("emu kill"))).toEqual([
    "-s emulator-5590 emu kill",
  ]);
  expect(
    proof.calls.every(
      (call) => call === "devices" || call.startsWith("-s emulator-5590 ")
    )
  ).toBe(true);
});

it("asks the instance to exit and does not signal it when that works", async () => {
  const proof = harness({
    bootShell: offlineShell,
    emuKill: (_serial, emulator) => {
      emulator.exitCode = 0;
      emulator.emit("exit", 0, null);
      return Promise.resolve({ stdout: "" });
    },
  });

  await expect(proof.start({ bootTimeoutMs: 1, pollMs: 0 })).rejects.toThrow();

  expect(proof.calls).toContain("-s emulator-5590 emu kill");
  expect(proof.signals).toEqual([]);
});

it("stops the emulator when it exits before it finishes booting", async () => {
  const proof = harness({
    bootShell: hangUntilAborted,
  });
  const started = proof.start({
    spawn: () => {
      queueMicrotask(() => {
        proof.emulator.exitCode = 1;
        proof.emulator.emit("exit", 1, null);
      });
      return proof.emulator;
    },
  });

  await expect(started).rejects.toThrow("exited before it finished booting");
  expect(proof.signals).toEqual([]);
  expect(proof.calls.some((call) => call.includes("emu kill"))).toBe(false);
});

it("stops the emulator when installing the build fails", async () => {
  const proof = harness({
    apkInstall: () => Promise.reject(new Error("INSTALL_FAILED")),
    bootShell: bootedShell,
    emuKill: (_serial, emulator) => {
      emulator.exitCode = 0;
      emulator.emit("exit", 0, null);
      return Promise.resolve({ stdout: "" });
    },
  });

  await expect(proof.start({ apk: "fixture.apk" })).rejects.toThrow(
    "INSTALL_FAILED"
  );
  expect(proof.calls).toContain("-s emulator-5590 emu kill");
});

it("stops a booting emulator once when a signal calls the tracked cleanup", async () => {
  const proof = harness({
    bootShell: hangUntilAborted,
    emuKill: () => Promise.reject(new Error("adb: device offline")),
  });
  const registered = Promise.withResolvers();
  const started = proof.start({ track: registered.resolve });
  const failure = expect(started).rejects.toThrow();
  const cleanup = await registered.promise;

  await Promise.all([cleanup(), cleanup()]);

  await failure;
  expect(proof.signals).toEqual([[OWNED_PID, "SIGTERM"]]);
});

it("stops the emulator through the returned cleanup after a good boot", async () => {
  const proof = harness({
    bootShell: bootedShell,
    emuKill: (_serial, emulator) => {
      emulator.exitCode = 0;
      emulator.emit("exit", 0, null);
      return Promise.resolve({ stdout: "" });
    },
  });

  const device = await proof.start();
  expect(device).toMatchObject({ pid: OWNED_PID, serial: "emulator-5590" });
  expect(proof.calls).not.toContain("-s emulator-5590 emu kill");

  await device.cleanup();
  expect(proof.calls).toContain("-s emulator-5590 emu kill");
});

it("refuses to launch over an existing emulator on the port", async () => {
  const proof = harness({ bootShell: offlineShell });
  await expect(
    proof.start({
      execute: () => Promise.resolve({ stdout: "emulator-5590\tdevice" }),
    })
  ).rejects.toThrow("already exists");
  expect(proof.launches).toEqual([]);
});

it("keeps waiting while the device reports offline, then boots", async () => {
  const replies = [
    offlineShell,
    offlineShell,
    offlineShell,
    () => Promise.resolve({ stdout: "0\n" }),
    bootedShell,
  ];
  const proof = harness({
    bootShell: () => replies.shift()(),
  });

  const device = await proof.start({ pollMs: 0 });

  expect(replies).toEqual([]);
  expect(proof.calls.filter((call) => call.includes("shell"))).toHaveLength(5);
  expect(proof.calls.some((call) => call.includes("emu kill"))).toBe(false);
  expect(proof.signals).toEqual([]);
  expect(device).toMatchObject({ pid: OWNED_PID, serial: "emulator-5590" });
});

it("signals the process group when the emulator console never answers", async () => {
  const proof = harness({
    bootShell: offlineShell,
    emuKill: () => Promise.withResolvers().promise,
  });

  await expect(proof.start({ bootTimeoutMs: 1, pollMs: 0 })).rejects.toThrow();

  expect(proof.calls).toContain("-s emulator-5590 emu kill");
  expect(proof.signals).toEqual([[OWNED_PID, "SIGTERM"]]);
});
