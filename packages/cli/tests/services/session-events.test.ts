import {
  AgentSessionSnapshot,
  TeachingCaptureState,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import type { TeachingRecordingOperation } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { SessionEventBatch } from "../../src/services/session-events.ts";
import { makeSessionEvents } from "../../src/services/session-events.ts";

const at = "2026-10-04T12:00:00.000Z";
const teaching = Schema.decodeUnknownSync(AgentSessionSnapshot)({
  activity: "teaching",
  captureState: { _tag: "setup", requestedAt: at },
  clientName: "test",
  clientVersion: "1",
  controller: "user",
  createdAt: at,
  currentUrl: "http://127.0.0.1/shop",
  flowSkillName: "cart",
  id: "agent-event-test",
  interruptedAction: null,
  ownerProcessId: "process-test",
  phase: "running",
  recordingId: "recording-event-test",
  run: null,
  takeover: null,
  teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
  timeline: [],
  updatedAt: at,
  viewUrl: "http://127.0.0.1/?session=agent-event-test",
});
const verifiedLifecycle = Schema.decodeUnknownSync(TeachingCaptureState)({
  _tag: "verified",
  draftedAt: at,
  dryRunEndedAt: at,
  dryRunResult: {
    completedAt: at,
    inputs: [],
    observableOutcome: "One anvil",
    outcome: "passed",
  },
  dryRunSessionId: "agent-dry-test",
  dryRunStartedAt: at,
  readyAt: at,
  skillPath: "cart/SKILL.md",
  startedAt: at,
  stoppedAt: at,
  verifiedAt: at,
});
const manifest = (
  origin: "agent" | "workspace",
  operation: TeachingRecordingOperation,
  cleanup: TeachingRecordingManifest["cleanup"],
  lifecycle: TeachingRecordingManifest["lifecycle"] = verifiedLifecycle
) =>
  Schema.decodeUnknownSync(TeachingRecordingManifest)({
    artifacts: [],
    cleanup,
    createdAt: at,
    emulation: {
      permissions: [],
      userAgentProfile: "default",
      viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
    },
    eventOrigin: origin,
    flowSkillName: "cart",
    lifecycle,
    receipts: [
      {
        completedAt: at,
        operation,
        operationId: `operation-${operation}`,
        origin,
      },
    ],
    recordingId: teaching.recordingId,
    schemaVersion: 1,
    sessionId: teaching.id,
    updatedAt: at,
  });

it.effect(
  "records Teaching and Setup Variable changes once and omits private values",
  () =>
    Effect.gen(function* teachingEvents() {
      if (teaching.activity !== "teaching") {
        return yield* Effect.die("Expected Teaching");
      }
      const log = makeSessionEvents();
      log.observe(teaching, "workspace");
      const initial = yield* log.read(teaching.id);
      const recording = {
        ...teaching,
        captureState: { _tag: "recording" as const, startedAt: at },
      };
      log.observe(recording, "workspace");
      const commented = {
        ...recording,
        teaching: {
          actionCount: 0,
          instructionCount: 2,
          instructions: [
            { at, id: "instruction-comment", target: null, text: "One anvil" },
            {
              at,
              id: "instruction-scan",
              scan: {
                id: "scan-1",
                mode: "accessibility" as const,
                phase: "start" as const,
              },
              target: null,
              text: "Scan the cart",
            },
          ],
        },
      };
      log.observe(commented, "workspace");
      log.observe(commented, "workspace");
      const finalizing = {
        ...commented,
        captureState: {
          _tag: "finalizing" as const,
          startedAt: at,
          stoppedAt: at,
        },
      };
      log.observe(finalizing, "workspace");
      const ready = {
        ...finalizing,
        captureState: {
          _tag: "ready" as const,
          readyAt: at,
          startedAt: at,
          stoppedAt: at,
        },
      };
      log.observe(ready, "workspace");
      log.observe(ready, "workspace");
      const discarded = {
        ...teaching,
        setupVariables: [
          {
            name: "PASSWORD",
            purpose: "Sign in",
            requestId: "setup-1",
            status: "requested" as const,
          },
        ],
      };
      log.observe(discarded, "workspace");
      log.observe(
        {
          ...discarded,
          setupVariables: [
            {
              name: "PASSWORD",
              purpose: "Sign in",
              requestId: "setup-1",
              status: "supplied",
            },
          ],
        },
        "workspace"
      );
      log.observe(
        {
          ...discarded,
          setupVariables: [
            {
              name: "PASSWORD",
              purpose: "Sign in",
              requestId: "setup-2",
              status: "refused",
            },
          ],
        },
        "workspace"
      );
      const result = yield* log.read(teaching.id, initial.eventCursor);
      expect(result.events.map((event) => event.kind)).toEqual([
        "teaching-started",
        "instruction-recorded",
        "scan-requirement-recorded",
        "teaching-stopped",
        "teaching-discarded",
        "variable-supplied",
        "variable-refused",
      ]);
      expect(Schema.is(Schema.Json)(result.events)).toBe(true);
    })
);

it.effect(
  "deduplicates durable choices and Cleanup, and suppresses agent origins",
  () =>
    Effect.gen(function* durableEvents() {
      const log = makeSessionEvents();
      const initial = yield* log.read(teaching.id);
      const verified = manifest("workspace", "verification", {
        _tag: "purge-pending",
        failure: null,
        retainedFiles: ["video.webm"],
      });
      if (verified.lifecycle._tag !== "verified") {
        return yield* Effect.die("Expected verification fixture");
      }
      log.observeManifest(teaching.id, verified);
      log.observeManifest(teaching.id, verified);
      log.observeManifest(
        teaching.id,
        manifest("workspace", "verification", {
          _tag: "purge-pending",
          failure: "Could not remove video",
          retainedFiles: ["video.webm"],
        })
      );
      log.observeManifest(
        teaching.id,
        manifest("workspace", "cleanup", { _tag: "purged", completedAt: at })
      );
      log.observeVerification(teaching.id, at, "workspace");
      log.observeManifest(
        teaching.id,
        manifest(
          "workspace",
          "reject",
          { _tag: "pending" },
          {
            _tag: "skill-drafted",
            draftedAt: at,
            readyAt: at,
            skillPath: "cart/SKILL.md",
            startedAt: at,
            stoppedAt: at,
          }
        )
      );
      log.observeManifest(
        teaching.id,
        manifest(
          "workspace",
          "fail-dry-run",
          { _tag: "pending" },
          {
            ...verified.lifecycle,
            _tag: "dry-run-failed",
            dryRunResult: {
              completedAt: at,
              inputs: [],
              observableOutcome:
                "The user stopped the Dry Run before it completed.",
              outcome: "failed",
            },
          }
        )
      );
      const result = yield* log.read(teaching.id, initial.eventCursor);
      expect(result.events.map((event) => event.kind)).toEqual([
        "flow-skill-verified",
        "cleanup-failed",
        "cleanup-completed",
        "flow-skill-rejected",
        "dry-run-stopped",
      ]);
      const agentLog = makeSessionEvents();
      const before = yield* agentLog.read(teaching.id);
      for (const operation of ["verification", "reject", "cleanup"] as const) {
        agentLog.observeManifest(
          teaching.id,
          manifest("agent", operation, { _tag: "purged", completedAt: at })
        );
      }
      agentLog.observeVerification(teaching.id, at, "agent");
      expect(
        (yield* agentLog.read(teaching.id, before.eventCursor)).events
      ).toEqual([]);
    })
);

it.effect(
  "retains a user stop receipt when a newer lifecycle supersedes the failure",
  () =>
    Effect.gen(function* stopReceipt() {
      const log = makeSessionEvents();
      const initial = yield* log.read(teaching.id);
      const current = manifest("workspace", "fail-dry-run", {
        _tag: "pending",
      });
      log.observeManifest(teaching.id, {
        ...current,
        receipts: current.receipts.map((receipt) => ({
          ...receipt,
          eventKind: "dry-run-stopped",
        })),
      });
      const result = yield* log.read(teaching.id, initial.eventCursor);
      expect(result.events.map((event) => event.kind)).toEqual([
        "dry-run-stopped",
      ]);
      const before = yield* log.read(teaching.id);
      log.observeManifest(teaching.id, current);
      expect((yield* log.read(teaching.id, before.eventCursor)).events).toEqual(
        []
      );
    })
);

it.effect(
  "pushes committed log batches once with their preceding replay cursor",
  () =>
    Effect.gen(function* pushLogBatches() {
      const batches: SessionEventBatch[] = [];
      const log = makeSessionEvents((batch) => {
        batches.push(batch);
      });
      log.observe(teaching, "workspace");
      const initial = yield* log.read(teaching.id);
      log.observeManifest(
        teaching.id,
        manifest("agent", "verification", { _tag: "pending" })
      );
      expect(batches).toEqual([]);
      const cleanup = manifest("workspace", "cleanup", {
        _tag: "purged",
        completedAt: at,
      });
      log.observeManifest(teaching.id, cleanup);
      log.observeManifest(teaching.id, cleanup);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.eventCursor).toBe(initial.eventCursor);
      expect(batches[0]?.events).toEqual(
        (yield* log.read(teaching.id, initial.eventCursor)).events
      );
      expect(batches[0]?.events.map((event) => event.kind)).toEqual([
        "cleanup-completed",
      ]);
    })
);
