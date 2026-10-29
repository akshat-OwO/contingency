import childProcess from "node:child_process";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { vi } from "vitest";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";

it.live("awaits Chromium exit when interrupted during launch", () =>
  Effect.gen(function* interruptedLaunch() {
    const launched = yield* Deferred.make<Browser>();
    const release = yield* Deferred.make<true>();
    const exited = yield* Deferred.make<true>();
    const spawn = vi.spyOn(childProcess, "spawn");
    const launch = chromium.launch.bind(chromium);
    const intercepted = vi
      .spyOn(chromium, "launch")
      .mockImplementation(async (options) => {
        const browser = await launch(options);
        await Effect.runPromise(Deferred.succeed(launched, browser));
        await Effect.runPromise(Deferred.await(release));
        return browser;
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        intercepted.mockRestore();
        spawn.mockRestore();
      })
    );
    const running = yield* Effect.gen(function* createSession() {
      const browser = yield* CreateBrowser;
      yield* browser.create("interrupted-launch", {
        deviceScaleFactor: 1,
        height: 480,
        width: 640,
      });
    }).pipe(Effect.provide(CreateBrowserLive), Effect.forkChild);
    const browser = yield* Deferred.await(launched).pipe(
      Effect.timeout("30 seconds")
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* cleanBrowser() {
        yield* Deferred.succeed(release, true);
        yield* Effect.promise(() => browser.close());
      })
    );
    const process = spawn.mock.results.find(
      (result) =>
        result.type === "return" &&
        result.value.spawnargs.includes("--remote-debugging-pipe")
    )?.value;
    if (process === undefined) {
      return yield* Effect.die("Missing Chromium child process");
    }
    process.once("exit", () => Effect.runSync(Deferred.succeed(exited, true)));
    running.interruptUnsafe();
    yield* Deferred.succeed(release, true);
    yield* Fiber.await(running).pipe(Effect.timeout("30 seconds"));
    expect(browser.isConnected()).toBe(false);
    expect(yield* Deferred.isDone(exited)).toBe(true);
  }).pipe(Effect.scoped)
);
