#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { commands } from "./cmds/index.ts";
import { CreateBrowserLive } from "./services/create-browser.ts";
import { UiInterfaceLive } from "./services/ui-interface.ts";

const servicesLayer = Layer.mergeAll(CreateBrowserLive, UiInterfaceLive).pipe(
  Layer.provideMerge(NodeServices.layer)
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

Command.run(commands, { version: packageJson.version }).pipe(
  Effect.provide(servicesLayer),
  NodeRuntime.runMain
);
