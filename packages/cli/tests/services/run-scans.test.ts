import path from "node:path";

import { TaskAgentRunState } from "@contingency/protocol";
import type { ScanReport, ScanMode } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Schema } from "effect";

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
