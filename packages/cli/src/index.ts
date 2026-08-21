#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { commands } from "./cmds/index";
import {
  AgentBrowserLive,
  inFlightBrowserCommands,
} from "./services/agent-browser";
import { RecordingLive } from "./services/cdp-recorder";
import { RunnerLive } from "./services/runner";
import { UiInterfaceLive } from "./services/ui-interface";

const browserAndRecordingLayer = Layer.merge(
  AgentBrowserLive,
  RecordingLive.pipe(Layer.provide(AgentBrowserLive))
);
const servicesLayer = Layer.mergeAll(
  browserAndRecordingLayer,
  UiInterfaceLive.pipe(Layer.provide(browserAndRecordingLayer)),
  RunnerLive.pipe(Layer.provide(AgentBrowserLive))
).pipe(Layer.provideMerge(NodeServices.layer));

/**
 * How long a signal is allowed to take to shut the process down.
 *
 * The runtime interrupts the main fiber on SIGINT/SIGTERM, and teardown is
 * bounded at every Effect level — a recording flush, a load stop, a browser
 * close each carry their own timeout. But those bounds all assume the fiber
 * gets to run, and there is one case where it may not: a browser command
 * whose answer depends on the browser finishing something else, such as a
 * recording start queued behind a navigation still in flight (ADR 0010). If
 * unwinding has not finished within this window, something below Effect is
 * stuck, and the only honest move is to stop pretending Ctrl-C is being
 * honoured: kill whatever browser command was in flight when the signal
 * arrived, which unblocks the queue, and exit if that was not enough.
 *
 * Six seconds, because a flush that was going to succeed gives up on its own
 * at five; whatever is still in flight past that point is stuck, not working.
 */
const FORCE_KILL_AFTER_MS = 6000;

/** How long the killed command gets to unwind before exiting outright. */
const HARD_EXIT_AFTER_MS = 25_000;

/**
 * How soon after the first signal a second one is read as a reflex rather than
 * as insistence.
 *
 * Ctrl-C is often pressed twice out of habit, and a graceful flush that is
 * going to succeed pins at roughly a fifth of a second — so a double-tap
 * inside that window would exit immediately and lose a recording that a single
 * press would have kept. Past this window the user is answering a shutdown
 * that visibly did not finish, which is exactly when the escape hatch should
 * work.
 */
const INSIST_AFTER_MS = 500;

const kill = (pids: Iterable<number>): void => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is exactly what we wanted.
    }
  }
};

let firstSignalAt: number | undefined;
const onSignal = (): void => {
  // Monotonic, so a clock adjustment mid-shutdown cannot widen or collapse the
  // reflex window.
  const now = performance.now();
  if (firstSignalAt !== undefined) {
    if (now - firstSignalAt < INSIST_AFTER_MS) {
      // A reflexive double-tap, not an instruction. Let the graceful shutdown
      // already under way finish; a later press still exits.
      return;
    }
    // The user insists. No more waiting.
    kill(inFlightBrowserCommands);
    process.exit(130);
  }
  firstSignalAt = now;
  // Only the commands already in flight are candidates for a force-kill.
  // Teardown itself issues browser commands — the recording flush, the load
  // stop, the close — and those carry legitimate Effect-level bounds that a
  // blanket kill would cut short.
  const stale = new Set(inFlightBrowserCommands);
  const forceKill = setTimeout(() => {
    // Intersect with what is still in flight now: a command that settled in
    // the meantime has been removed from the registry, and signalling its
    // former pid could hit a process the OS handed that number to since.
    kill([...stale].filter((pid) => inFlightBrowserCommands.has(pid)));
  }, FORCE_KILL_AFTER_MS);
  forceKill.unref();
  const hardExit = setTimeout(() => {
    console.error(
      "\nThe Run did not shut down after the interrupt; forcing exit. " +
        "A recording in flight may be lost."
    );
    process.exit(130);
  }, HARD_EXIT_AFTER_MS);
  hardExit.unref();
};

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

Command.run(commands, { version: packageJson.version }).pipe(
  Effect.provide(servicesLayer),
  NodeRuntime.runMain
);
