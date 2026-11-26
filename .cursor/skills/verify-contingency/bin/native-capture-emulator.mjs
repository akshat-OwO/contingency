/* oxlint-disable eslint/no-await-in-loop -- The boot wait polls the device one probe at a time. */
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const BOOT_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 30_000;

// Boots one proof-owned Android emulator and returns a cleanup that stops that
// instance and nothing else. The emulator runs in its own process group, so the
// cleanup can reach the launcher and everything it started by the PID this
// function spawned, and no other emulator is ever matched by name. Cleanup is
// registered through `track` before the first boot wait, so a signal that
// arrives mid-boot reaches it too, and every failure after the spawn runs it
// before the error propagates.
export const startEmulator = async ({
  adb,
  apk,
  avd,
  bootTimeoutMs = BOOT_TIMEOUT_MS,
  emulatorBinary,
  execute,
  graceMs = 10_000,
  killGroup = (pid, signal) => process.kill(-pid, signal),
  pollMs = 1000,
  port,
  spawn = nodeSpawn,
  track,
}) => {
  const serial = `emulator-${port}`;
  const { stdout: devices } = await execute(adb, ["devices"]);
  assert.ok(
    !devices.includes(serial),
    `${serial} already exists; pass another --port`
  );
  const emulator = spawn(
    emulatorBinary,
    [
      "-avd",
      avd,
      "-port",
      String(port),
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      "-no-window",
      "-read-only",
    ],
    { detached: true, stdio: "ignore" }
  );
  const hasExited = () =>
    emulator.pid === undefined ||
    emulator.exitCode !== null ||
    emulator.signalCode !== null;
  // An error event (the launcher failed to start) also ends the wait.
  const exited = (async () => {
    try {
      await once(emulator, "exit");
    } catch {
      // The launcher never started, so there is nothing left to wait for.
    }
  })();
  const exitedWithin = async (milliseconds) => {
    const timer = new AbortController();
    const expired = (async () => {
      try {
        await sleep(milliseconds, undefined, { signal: timer.signal });
      } catch {
        // Aborted because the emulator exited first.
      }
    })();
    await Promise.race([exited, expired]);
    timer.abort();
  };
  const signalGroup = (signal) => {
    try {
      killGroup(emulator.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };
  const boot = new AbortController();
  let stopping;
  const stop = async () => {
    boot.abort();
    if (hasExited()) {
      return;
    }
    try {
      await execute(adb, ["-s", serial, "emu", "kill"]);
      await exitedWithin(graceMs);
    } catch {
      // An offline device cannot take the request; the signals below follow.
    }
    if (!hasExited()) {
      signalGroup("SIGTERM");
      await exitedWithin(graceMs);
    }
    if (!hasExited()) {
      signalGroup("SIGKILL");
      await exited;
    }
  };
  const cleanup = () => {
    stopping ??= stop();
    return stopping;
  };
  track?.(cleanup);
  const earlyExit = (async () => {
    await exited;
    throw new Error(`Emulator ${serial} exited before it finished booting`);
  })();
  const bootWait = AbortSignal.any([
    boot.signal,
    AbortSignal.timeout(bootTimeoutMs),
  ]);
  // A booting emulator reports offline, and adb shell exits 255 until it
  // connects, so a failed probe is another attempt and only the deadline ends
  // the wait.
  const waitForBoot = async () => {
    await execute(adb, ["-s", serial, "wait-for-device"], {
      signal: bootWait,
    });
    for (;;) {
      bootWait.throwIfAborted();
      try {
        const { stdout } = await execute(
          adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          { signal: bootWait, timeout: PROBE_TIMEOUT_MS }
        );
        if (stdout.trim() === "1") {
          return;
        }
      } catch (error) {
        if (bootWait.aborted) {
          throw error;
        }
      }
      await sleep(pollMs, undefined, { signal: bootWait });
    }
  };
  try {
    // Boot completion is a device property, so this waits on the device's own signal.
    await Promise.race([waitForBoot(), earlyExit]);
    if (apk !== undefined) {
      await execute(adb, ["-s", serial, "install", "-r", apk]);
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { cleanup, pid: emulator.pid, serial };
};
