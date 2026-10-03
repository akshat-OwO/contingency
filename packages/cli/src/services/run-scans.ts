import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ScanReference,
  ScanMode,
  ScanReport,
  SessionEmulation,
  TaskAgentRunState,
} from "@contingency/protocol";
import { Effect, Result, Semaphore } from "effect";
import type { FileSystem } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { agentSessionError } from "./agent-session-error.ts";
import type { AgentSessionError } from "./agent-session-error.ts";
import type { ScanCollection, ScanEngineReport } from "./scan-engine.ts";

interface ScanOwner {
  readonly sessionId: string;
  readonly run: TaskAgentRunState;
  readonly directory: string;
  readonly emulation: SessionEmulation;
  readonly page: {
    readonly url: () => string;
    readonly once: (event: "close", listener: () => void) => void;
    readonly off: (event: "close", listener: () => void) => void;
  };
  readonly collect: (
    mode: ScanMode,
    signal: AbortSignal
  ) => Promise<ScanCollection>;
  readonly tabId: string;
  readonly publish: (
    report: ScanReport
  ) => Effect.Effect<void, AgentSessionError>;
}
interface ActiveScan {
  readonly owner: ScanOwner;
  readonly requirement: ScanReference;
  readonly report: ScanReport;
  readonly collection: ScanCollection;
  readonly closed: () => void;
}

const conflict = (message: string) =>
  agentSessionError("agent_session_conflict", message);
const failed = (cause: unknown) =>
  agentSessionError(
    "agent_session_unavailable",
    `Scanner failure: ${String(cause)}`
  );

export const makeRunScans = (
  fileSystem: FileSystem.FileSystem | undefined,
  now: () => Date
) => {
  const registry = AtomRegistry.make();
  const collecting = Atom.make<
    ReadonlyMap<
      string,
      { readonly controller: AbortController; readonly reason?: string }
    >
  >(new Map()).pipe(Atom.keepAlive);
  const interrupt = (sessionId: string, reason: string) => {
    const request = registry.get(collecting).get(sessionId) ?? {
      controller: new AbortController(),
    };
    registry.update(collecting, (current) =>
      new Map(current).set(sessionId, { ...request, reason })
    );
    request.controller.abort(reason);
  };
  const clearCollection = (sessionId: string) =>
    registry.update(collecting, (current) => {
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  const active = Atom.make<ReadonlyMap<string, ActiveScan>>(new Map()).pipe(
    Atom.keepAlive
  );
  const locks = Atom.make<ReadonlyMap<string, Semaphore.Semaphore>>(
    new Map()
  ).pipe(Atom.keepAlive);
  const lockFor = (sessionId: string) => {
    const existing = registry.get(locks).get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const lock = Semaphore.makeUnsafe(1);
    registry.update(locks, (current) => new Map(current).set(sessionId, lock));
    return lock;
  };
  const setActive = (sessionId: string, scan?: ActiveScan) =>
    registry.update(active, (current) => {
      const next = new Map(current);
      if (scan === undefined) {
        next.delete(sessionId);
      } else {
        next.set(sessionId, scan);
      }
      return next;
    });
  const persist = (
    owner: ScanOwner,
    report: ScanReport,
    content:
      | ScanEngineReport
      | { readonly error: string }
      | { readonly partial: true; readonly reason: string }
  ) =>
    Effect.gen(function* persistScanEvidence() {
      if (fileSystem === undefined) {
        return yield* Effect.fail(
          failed("No evidence filesystem is available.")
        );
      }
      const reportPath = `scans/${report.id}.json`;
      yield* fileSystem
        .makeDirectory(path.join(owner.directory, "scans"), {
          mode: 0o700,
          recursive: true,
        })
        .pipe(Effect.mapError(failed));
      yield* fileSystem
        .writeFileString(
          path.join(owner.directory, reportPath),
          JSON.stringify(
            {
              content,
              emulation: owner.emulation,
              measurement:
                report.mode === "timespan"
                  ? "Agent-driven elapsed interval, including reasoning time"
                  : "Run browser settings",
              requirement: (owner.run.scanRequirements ?? []).find(
                (scan) =>
                  scan.flowSkillName === report.flowSkillName &&
                  scan.id === report.requirementId
              ),
              scan: report,
            },
            null,
            2
          ),
          { mode: 0o600 }
        )
        .pipe(Effect.mapError(failed));
      yield* owner.publish({ ...report, reportPath });
    });

  const stopUnlocked = (sessionId: string, reason?: string) =>
    Effect.gen(function* stopScan() {
      const scan = registry.get(active).get(sessionId);
      if (scan === undefined) {
        return;
      }
      scan.owner.page.off("close", scan.closed);
      const endedAt = now().toISOString();
      const wrongDestination =
        scan.requirement.mode === "navigation" &&
        (scan.requirement.expectedUrl === undefined ||
          scan.owner.page.url() !== new URL(scan.requirement.expectedUrl).href);
      const partialReason =
        reason ??
        registry.get(collecting).get(sessionId)?.reason ??
        (wrongDestination
          ? "The navigation did not reach the reviewed destination."
          : undefined);
      const cancel = Effect.tryPromise({
        catch: failed,
        try: scan.collection.cancel,
      }).pipe(Effect.ignore);
      yield* Effect.gen(function* finishAndPersist() {
        if (partialReason !== undefined) {
          yield* cancel;
          yield* persist(
            scan.owner,
            {
              ...scan.report,
              durationMs:
                Date.parse(endedAt) - Date.parse(scan.report.startedAt),
              endedAt,
              status: "partial",
              summary: partialReason,
            },
            { partial: true, reason: partialReason }
          );
          return;
        }
        const result = yield* Effect.result(
          Effect.tryPromise({
            catch: failed,
            try: () => scan.collection.finish(),
          }).pipe(Effect.timeout("45 seconds"))
        );
        const interrupted = registry.get(collecting).get(sessionId)?.reason;
        if (interrupted !== undefined) {
          yield* persist(
            scan.owner,
            {
              ...scan.report,
              durationMs:
                Date.parse(endedAt) - Date.parse(scan.report.startedAt),
              endedAt,
              status: "partial",
              summary: interrupted,
            },
            { partial: true, reason: interrupted }
          );
          return;
        }
        const report: ScanReport = {
          ...scan.report,
          durationMs: Date.parse(endedAt) - Date.parse(scan.report.startedAt),
          endedAt,
          status: Result.isFailure(result) ? "failed" : "completed",
          summary: Result.isFailure(result)
            ? `Scanner failure: ${result.failure.message}`
            : result.success.summary,
        };
        yield* persist(
          scan.owner,
          report,
          Result.isSuccess(result)
            ? result.success.report
            : { error: result.failure.message }
        );
      }).pipe(Effect.ensuring(cancel));
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          setActive(sessionId);
          clearCollection(sessionId);
        })
      )
    );

  const stop = (sessionId: string, reason?: string) =>
    stopUnlocked(sessionId, reason).pipe(lockFor(sessionId).withPermits(1));
  const start = (
    owner: ScanOwner,
    requirement: ScanReference,
    retryInstructionAt?: string
  ) =>
    Effect.gen(function* startScan() {
      if (registry.get(active).has(owner.sessionId)) {
        return yield* Effect.fail(
          conflict("End the active scan before starting another.")
        );
      }
      const attempts = (owner.run.scanReports ?? []).filter(
        (report) =>
          report.flowSkillName === requirement.flowSkillName &&
          report.requirementId === requirement.id
      );
      if (attempts.some((report) => report.status === "completed")) {
        return yield* Effect.fail(
          conflict("This requirement is already fulfilled for this Run.")
        );
      }
      const lastAttempt = attempts.at(-1);
      const userRetry =
        retryInstructionAt !== undefined &&
        owner.run.instructions.some(
          (instruction) =>
            instruction.receivedAt === retryInstructionAt &&
            Date.parse(instruction.receivedAt) >
              Date.parse(lastAttempt?.startedAt ?? "")
        );
      if (attempts.length >= 2 && !userRetry) {
        return yield* Effect.fail(
          conflict(
            "Two attempts are already recorded. Further retries require a new explicit user instruction."
          )
        );
      }
      const report: ScanReport = {
        flowSkillName: requirement.flowSkillName,
        id: `scan-${randomUUID()}`,
        mode: requirement.mode,
        requirementId: requirement.id,
        startedAt: now().toISOString(),
        status: "running",
        summary: "Collecting required scan evidence.",
        tabId: owner.tabId,
        url: owner.page.url(),
      };
      yield* owner.publish(report);
      const request = registry.get(collecting).get(owner.sessionId) ?? {
        controller: new AbortController(),
      };
      const { controller } = request;
      registry.update(collecting, (current) =>
        new Map(current).set(owner.sessionId, request)
      );
      const closed = () => {
        interrupt(owner.sessionId, "The measured tab closed.");
        Effect.runFork(stop(owner.sessionId, "The measured tab closed."));
      };
      owner.page.once("close", closed);
      const collected = yield* Effect.result(
        Effect.tryPromise({
          catch: failed,
          try: (signal) =>
            owner.collect(
              requirement.mode,
              AbortSignal.any([signal, controller.signal])
            ),
        }).pipe(Effect.timeout("45 seconds"))
      );
      if (Result.isFailure(collected)) {
        owner.page.off("close", closed);
        const reason = registry.get(collecting).get(owner.sessionId)?.reason;
        yield* persist(
          owner,
          {
            ...report,
            endedAt: now().toISOString(),
            status: reason === undefined ? "failed" : "partial",
            summary: reason ?? collected.failure.message,
          },
          reason === undefined
            ? { error: collected.failure.message }
            : { partial: true, reason }
        );
        clearCollection(owner.sessionId);
        return;
      }
      setActive(owner.sessionId, {
        closed,
        collection: collected.success,
        owner,
        report,
        requirement,
      });
      if (
        requirement.mode === "accessibility" ||
        requirement.mode === "reload"
      ) {
        yield* stopUnlocked(owner.sessionId);
      }
    }).pipe(lockFor(owner.sessionId).withPermits(1));
  return {
    current: (sessionId: string) => registry.get(active).get(sessionId)?.report,
    interrupt,
    start,
    stop,
    withInterruption: <A, E, R>(
      sessionId: string,
      reason: string,
      operation: Effect.Effect<A, E, R>
    ) =>
      Effect.sync(() => interrupt(sessionId, reason)).pipe(
        Effect.flatMap(() => operation),
        Effect.ensuring(
          Effect.sync(() => {
            if (!registry.get(active).has(sessionId)) {
              clearCollection(sessionId);
            }
          })
        )
      ),
  };
};
