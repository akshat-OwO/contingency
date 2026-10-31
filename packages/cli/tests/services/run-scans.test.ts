import path from "node:path";

import { TaskAgentRunState } from "@contingency/protocol";
import type { ScanReport, ScanMode } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";

import { makeRunScans } from "../../src/services/run-scans.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const requirement = {
  flowSkillName: "shop",
  id: "load",
  mode: "reload" as const,
  when: "Home is loaded",
};
const run = () =>
  Schema.decodeUnknownSync(TaskAgentRunState)({
    ...taskRunSummary,
    lastAgentActivityAt: taskRunSummary.startedAt,
    lifecycle: { phase: "running" },
    scanReports: [],
    scanRequirements: [requirement],
  });
const page = {
  off: () => page,
  once: () => page,
  url: () => "https://shop.test/",
};

it.effect(
  "Takeover interrupts collection without waiting for the scan lock and persists partial coverage",
  () =>
    Effect.gen(function* interruptCollection() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const reports: ScanReport[] = [];
      const started = Promise.withResolvers<boolean>();
      const finished = Promise.withResolvers<{
        report: never;
        summary: string;
      }>();
      let cancelled = false;
      const scans = makeRunScans(fs, () => new Date("2026-10-03T00:00:00Z"));
      const collect = (_mode: ScanMode, signal: AbortSignal) =>
        Promise.resolve({
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
          finish: () => {
            signal.addEventListener(
              "abort",
              () => finished.reject(new Error("interrupted")),
              { once: true }
            );
            started.resolve(true);
            return finished.promise;
          },
        });
      const owner = {
        collect,
        directory,
        emulation: {
          ...taskRunSummary.startingEmulation,
          userAgent: "scan-test",
        },
        page,
        publish: (report: ScanReport) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        run: run(),
        sessionId: "session",
        tabId: "tab",
      };
      const fiber = yield* Effect.forkChild(scans.start(owner, requirement));
      yield* Effect.promise(() => started.promise);
      scans.interrupt("session", "The user took control.");
      yield* Fiber.join(fiber);
      expect(cancelled).toBe(true);
      expect(scans.current("session")).toBeUndefined();
      const report = reports.at(-1);
      if (report?.reportPath === undefined) {
        throw new Error("Missing persisted report");
      }
      expect(report.status).toBe("partial");
      expect(report.summary).toBe("The user took control.");
      const saved = JSON.parse(
        yield* fs.readFileString(path.join(directory, report.reportPath))
      );
      expect(saved.content).toEqual({
        partial: true,
        reason: "The user took control.",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "additional failed attempts require a recorded user instruction newer than the last attempt",
  () =>
    Effect.gen(function* requireRetryInstruction() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      let state = run();
      let tick = 0;
      const scans = makeRunScans(fs, () => {
        const at = new Date(Date.UTC(2026, 9, 3, 0, 0, tick));
        tick += 1;
        return at;
      });
      const owner = () => ({
        collect: () => Promise.reject(new Error("engine unavailable")),
        directory,
        emulation: {
          ...taskRunSummary.startingEmulation,
          userAgent: "scan-test",
        },
        page,
        publish: (report: ScanReport) =>
          Effect.sync(() => {
            state = {
              ...state,
              scanReports: [
                ...(state.scanReports ?? []).filter(
                  (previous) => previous.id !== report.id
                ),
                report,
              ],
            };
          }),
        run: state,
        sessionId: "session",
        tabId: "tab",
      });
      yield* scans.start(owner(), requirement);
      yield* scans.start(owner(), requirement);
      const denied = yield* Effect.flip(scans.start(owner(), requirement));
      expect(denied.message).toContain("explicit user instruction");
      const receivedAt = "2026-10-03T00:00:04.000Z";
      state = {
        ...state,
        instructions: [
          ...state.instructions,
          { instruction: "Retry the performance scan.", receivedAt },
        ],
      };
      yield* scans.start(owner(), requirement, receivedAt);
      expect(state.scanReports).toHaveLength(3);
      const reused = yield* Effect.flip(
        scans.start(owner(), requirement, receivedAt)
      );
      expect(reused.message).toContain("explicit user instruction");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each([
  { label: "fails", operation: Effect.fail(new Error("Failed takeover")) },
  { label: "dies", operation: Effect.die(new Error("Failed takeover")) },
  { label: "is interrupted", operation: Effect.interrupt },
])(
  "clears a pending interruption when takeover $label before collection",
  ({ operation }) =>
    Effect.gen(function* clearFailedTakeover() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const reports: ScanReport[] = [];
      let wasAborted = true;
      const scans = makeRunScans(fs, () => new Date("2026-10-03T00:00:00Z"));
      const takeover = yield* Effect.forkChild(
        scans.withInterruption("session", "Failed takeover", operation)
      );
      yield* Fiber.await(takeover);
      yield* scans.start(
        {
          collect: (_mode, signal) => {
            wasAborted = signal.aborted;
            return Promise.reject(new Error("Expected engine refusal"));
          },
          directory,
          emulation: {
            ...taskRunSummary.startingEmulation,
            userAgent: "scan-test",
          },
          page,
          publish: (report) =>
            Effect.sync(() => {
              reports.push(report);
            }),
          run: run(),
          sessionId: "session",
          tabId: "tab",
        },
        requirement
      );
      expect(wasAborted).toBe(false);
      expect(reports.at(-1)?.status).toBe("failed");
      expect(reports.at(-1)?.summary).not.toContain("Failed takeover");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("includes finishing time in the persisted scan duration", () =>
  Effect.gen(function* finishingDuration() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const reports: ScanReport[] = [];
    const finishing = Promise.withResolvers<boolean>();
    const release = Promise.withResolvers<boolean>();
    const clock = yield* Clock.Clock;
    const startedAt = clock.currentTimeMillisUnsafe();
    const scans = makeRunScans(
      fs,
      () => new Date(clock.currentTimeMillisUnsafe())
    );
    const fiber = yield* Effect.forkChild(
      scans.start(
        {
          collect: () =>
            Promise.resolve({
              cancel: () => Promise.resolve(),
              finish: async () => {
                finishing.resolve(true);
                await release.promise;
                return {
                  report: {
                    coverage: "test",
                    engine: "axe-core" as const,
                    engineVersion: "test",
                    results: { incomplete: [], violations: [] },
                  },
                  summary: "Finished",
                };
              },
            }),
          directory,
          emulation: {
            ...taskRunSummary.startingEmulation,
            userAgent: "scan-test",
          },
          page,
          publish: (report) =>
            Effect.sync(() => {
              reports.push(report);
            }),
          run: run(),
          sessionId: "session",
          tabId: "tab",
        },
        requirement
      )
    );
    yield* Effect.promise(() => finishing.promise);
    yield* TestClock.adjust("12 seconds");
    release.resolve(true);
    yield* Fiber.join(fiber);
    const report = reports.at(-1);
    expect(report?.durationMs).toBe(12_000);
    expect(report?.endedAt).toBe(new Date(startedAt + 12_000).toISOString());
    const saved = JSON.parse(
      yield* fs.readFileString(
        path.join(directory, report?.reportPath ?? "missing")
      )
    );
    expect(saved.scan.durationMs).toBe(12_000);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect.each(["setup", "finish"] as const)(
  "names the timed-out scanner phase during $0 and releases the scanner",
  (stage) =>
    Effect.gen(function* timeoutPhase() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const reports: ScanReport[] = [];
      const waiting = Promise.withResolvers<boolean>();
      const held = Promise.withResolvers<never>();
      const clock = yield* Clock.Clock;
      let cancelled = false;
      let aborted = false;
      const scans = makeRunScans(
        fs,
        () => new Date(clock.currentTimeMillisUnsafe())
      );
      const fiber = yield* Effect.forkChild(
        scans.start(
          {
            collect: (_mode, signal, onPhase) => {
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                },
                { once: true }
              );
              if (stage === "setup") {
                onPhase("navigation/load");
                waiting.resolve(true);
                return held.promise;
              }
              return Promise.resolve({
                cancel: () => {
                  cancelled = true;
                  return Promise.resolve();
                },
                finish: () => {
                  waiting.resolve(true);
                  return held.promise;
                },
                phase: () => "Lighthouse audit/trace processing" as const,
              });
            },
            directory,
            emulation: {
              ...taskRunSummary.startingEmulation,
              userAgent: "scan-test",
            },
            page,
            publish: (report) =>
              Effect.sync(() => {
                reports.push(report);
              }),
            run: run(),
            sessionId: "session",
            tabId: "tab",
          },
          requirement
        )
      );
      yield* Effect.promise(() => waiting.promise);
      yield* TestClock.adjust("45 seconds");
      yield* Fiber.join(fiber);
      const report = reports.at(-1);
      expect(report?.status).toBe("failed");
      expect(report?.durationMs).toBe(45_000);
      expect(report?.summary).toContain(
        stage === "setup"
          ? "navigation/load"
          : "Lighthouse audit/trace processing"
      );
      expect(report?.summary).toContain("Timed out after 45s during");
      expect(scans.current("session")).toBeUndefined();
      expect(stage === "setup" ? aborted : cancelled).toBe(true);
      const saved = JSON.parse(
        yield* fs.readFileString(
          path.join(directory, report?.reportPath ?? "missing")
        )
      );
      expect(saved.content.error).toContain("Timed out after 45s during");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("retains engine evidence when the engine reports a failure", () =>
  Effect.gen(function* retainFailedReport() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const reports: ScanReport[] = [];
    const content = {
      coverage: "test",
      engine: "axe-core" as const,
      engineVersion: "test",
      results: { incomplete: [], violations: [] },
    };
    const scans = makeRunScans(fs, () => new Date(0));
    yield* scans.start(
      {
        collect: () =>
          Promise.resolve({
            cancel: () => Promise.resolve(),
            finish: () =>
              Promise.resolve({
                report: content,
                status: "failed" as const,
                summary: "Lighthouse runtime error: navigation failed",
              }),
          }),
        directory,
        emulation: {
          ...taskRunSummary.startingEmulation,
          userAgent: "scan-test",
        },
        page,
        publish: (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        run: run(),
        sessionId: "session",
        tabId: "tab",
      },
      requirement
    );
    const report = reports.at(-1);
    expect(report?.status).toBe("failed");
    const saved = JSON.parse(
      yield* fs.readFileString(
        path.join(directory, report?.reportPath ?? "missing")
      )
    );
    expect(saved.content).toEqual(content);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
