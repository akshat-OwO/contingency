#!/usr/bin/env node

import os from "node:os";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { Command } from "effect/cli";

import packageJson from "../package.json" with { type: "json" };
import { commands } from "./cmds/index.ts";
import { AgentHarnessesLive } from "./services/agent-harnesses.ts";
import { CreateBrowserLive } from "./services/create-browser.ts";
import { LocalSystemOneLive } from "./services/local-system-one-live.ts";
import { superviseLocalSystemOne } from "./services/local-system-one-supervisor.ts";
import {
  cliConfigLayer,
  environmentLevel,
  makeObservabilityLayer,
  makeTelemetryLayer,
} from "./services/observability.ts";
import { OwnedDevicesLive } from "./services/owned-devices.ts";
import { PlatformRuntimeFactoryLive } from "./services/platform-runtime-live.ts";
import { loadSettings, userSettingsDirectory } from "./services/settings.ts";
import { UiInterfaceLive } from "./services/ui-interface.ts";

const home = os.homedir();

// Every log record reaches the Diagnostic Log; the terminal shows Warn and
// above on stderr until a command applies --debug or the log.level Setting.
const observabilityLayer = makeObservabilityLayer({
  colors: process.stderr.isTTY === true && process.env.NO_COLOR === undefined,
  home,
  level: environmentLevel(process.env),
  logFile: true,
  now: new Date(),
  pid: process.pid,
  writeTerminal: (line) => {
    process.stderr.write(`${line}\n`);
  },
}).pipe(Layer.provide(NodeServices.layer));

// Telemetry follows the environment and the user's own file only: a project
// file never chooses where this machine's spans go (ADR 0063).
const telemetryLayer = Layer.unwrap(
  loadSettings({
    catalogRoot: userSettingsDirectory(home),
    env: process.env,
    home,
  }).pipe(
    Effect.map((settings) => makeTelemetryLayer(settings.provider, { home })),
    // An invalid user file fails the command that reads it, with its message.
    Effect.orElseSucceed(() =>
      makeTelemetryLayer(ConfigProvider.fromEnv(), { home })
    )
  )
).pipe(Layer.provide(NodeServices.layer));

// Every command runs inside these services, so the devices this process
// starts are stopped only after the command's sessions have closed.
const servicesLayer = Layer.mergeAll(
  AgentHarnessesLive,
  CreateBrowserLive,
  OwnedDevicesLive,
  UiInterfaceLive,
  PlatformRuntimeFactoryLive.pipe(Layer.provide(CreateBrowserLive))
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(cliConfigLayer),
  Layer.provideMerge(telemetryLayer),
  Layer.provideMerge(observabilityLayer)
);

/**
 * How soon after the first signal a second one is read as a reflex rather
 * than as insistence.
 *
 * Ctrl-C is often pressed twice out of habit. The first signal starts an
 * unwind whose finalizers flush a Demonstration and close Chromium; asking the
 * runtime to interrupt again mid-teardown wedges it instead of hurrying it
 * along. So the runtime is handed exactly one signal, and every later one is
 * answered here: swallowed inside the reflex window, honoured past it.
 */
const INSIST_AFTER_MS = 500;

let shutdownStartedAt: number | undefined;

const insist = (): void => {
  if (
    shutdownStartedAt === undefined ||
    performance.now() - shutdownStartedAt < INSIST_AFTER_MS
  ) {
    return;
  }
  console.error("\nShutdown did not finish; exiting anyway.");
  process.exit(130);
};

const onFirstSignal = (): void => {
  if (shutdownStartedAt !== undefined) {
    return;
  }
  shutdownStartedAt = performance.now();
  console.error("Closing Contingency… press Ctrl+C again to force stop.");
  // The runtime's own listener was copied into this emit and still runs, so
  // the fiber is interrupted exactly once. Every signal after this one
  // reaches only the insistence guard above.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", insist);
  process.on("SIGTERM", insist);
};

process.on("SIGINT", onFirstSignal);
process.on("SIGTERM", onFirstSignal);

(process.argv[2] === "system-one" && process.argv[3] === "__supervise"
  ? superviseLocalSystemOne.pipe(Effect.provide(LocalSystemOneLive))
  : Command.run(commands, { version: packageJson.version })
).pipe(Effect.provide(servicesLayer), NodeRuntime.runMain);
