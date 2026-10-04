import { randomUUID } from "node:crypto";

import type {
  AgentSessionId,
  AgentSessionSnapshot,
  SessionEvent,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { Context, Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { agentSessionError } from "./agent-session-error.ts";

/** The adapter supplies origin; asynchronous durable reads use persisted origins. */
export const SessionEventOrigin = Context.Reference<"agent" | "workspace">(
  "contingency/SessionEventOrigin",
  { defaultValue: () => "workspace" }
);
export const fromAgent = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, SessionEventOrigin, "agent");

interface Log {
  readonly epoch: string;
  readonly sequence: number;
  readonly events: readonly SessionEvent[];
  readonly snapshot: AgentSessionSnapshot | undefined;
  readonly receipts: ReadonlySet<string>;
  readonly cleanupFailure: string | undefined;
  readonly verifiedAt: string | undefined;
  readonly cleanupCompleted: boolean;
}

const cursor = (log: Log) => `${log.epoch}:${log.sequence}`;
const append = (
  log: Log,
  kind: SessionEvent["kind"],
  at: string,
  name?: string
): Log => {
  const sequence = log.sequence + 1;
  const base = { at, cursor: `${log.epoch}:${sequence}`, kind };
  const event = name === undefined ? base : { ...base, name };
  return { ...log, events: [...log.events, event].slice(-256), sequence };
};

type Emit = (kind: SessionEvent["kind"], name?: string) => void;
const teachingChanges = (
  previous: AgentSessionSnapshot,
  snapshot: AgentSessionSnapshot,
  emit: Emit
) => {
  if (snapshot.activity === "teaching" && previous.activity === "teaching") {
    const before = previous.captureState._tag;
    const after = snapshot.captureState._tag;
    if (after === "recording" && before !== after) {
      emit("teaching-started");
    }
    if (before === "recording" && after === "finalizing") {
      emit("teaching-stopped");
    }
    if (after === "setup" && before !== "setup") {
      emit("teaching-discarded");
    }
    const known = new Set(
      previous.teaching.instructions.map((instruction) => instruction.id)
    );
    for (const instruction of snapshot.teaching.instructions) {
      if (!known.has(instruction.id)) {
        emit(
          instruction.scan === undefined || instruction.scan === null
            ? "instruction-recorded"
            : "scan-requirement-recorded"
        );
      }
    }
  }
};
const setupChanges = (
  previous: AgentSessionSnapshot,
  snapshot: AgentSessionSnapshot,
  emit: Emit
) => {
  const oldSetup = new Map(
    previous.setupVariables?.map((variable) => [variable.requestId, variable])
  );
  for (const variable of snapshot.setupVariables ?? []) {
    const old = oldSetup.get(variable.requestId);
    if (
      variable.status !== old?.status &&
      (variable.status === "supplied" || variable.status === "refused")
    ) {
      emit(
        variable.status === "supplied"
          ? "variable-supplied"
          : "variable-refused",
        variable.name
      );
    }
  }
};
const runVariableChanges = (
  previous: AgentSessionSnapshot,
  snapshot: AgentSessionSnapshot,
  emit: Emit
) => {
  const decisions = new Set(
    previous.decisionHistory.map((decision) => decision.pendingDecisionId)
  );
  for (const decision of snapshot.decisionHistory) {
    if (
      !decisions.has(decision.pendingDecisionId) &&
      decision.kind === "supply_variable"
    ) {
      emit(
        decision.decision === "supply"
          ? "variable-supplied"
          : "variable-refused",
        decision.variableName ?? undefined
      );
    }
  }
  const oldDryRun = new Map(
    previous.dryRun?.variables.map((variable) => [variable.name, variable])
  );
  const answeredNames = new Set<string | null>();
  for (const decision of snapshot.decisionHistory) {
    if (!decisions.has(decision.pendingDecisionId)) {
      answeredNames.add(decision.variableName);
    }
  }
  for (const variable of snapshot.dryRun?.variables ?? []) {
    if (
      variable.supplied &&
      !oldDryRun.get(variable.name)?.supplied &&
      !answeredNames.has(variable.name)
    ) {
      emit("variable-supplied", variable.name);
    }
  }
};

const isStoppedDryRun = (manifest: TeachingRecordingManifest) =>
  manifest.lifecycle._tag === "dry-run-failed" &&
  manifest.lifecycle.dryRunResult.observableOutcome ===
    "The user stopped the Dry Run before it completed.";

/** Each session keeps 256 replayable events. Reads never consume them. */
export const makeSessionEvents = () => {
  const registry = AtomRegistry.make();
  const logs = new Map<AgentSessionId, Atom.Writable<Log>>();
  const atomFor = (id: AgentSessionId) => {
    const existing = logs.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const atom = Atom.make<Log>({
      cleanupCompleted: false,
      cleanupFailure: undefined,
      epoch: randomUUID(),
      events: [],
      receipts: new Set<string>(),
      sequence: 0,
      snapshot: undefined,
      verifiedAt: undefined,
    }).pipe(Atom.keepAlive);
    logs.set(id, atom);
    return atom;
  };
  const observe = (
    snapshot: AgentSessionSnapshot,
    origin: "agent" | "workspace"
  ) => {
    const atom = atomFor(snapshot.id);
    let log = registry.get(atom);
    const previous = log.snapshot;
    if (previous !== undefined && origin === "workspace") {
      const emit = (kind: SessionEvent["kind"], name?: string) => {
        log = append(log, kind, snapshot.updatedAt, name);
      };
      teachingChanges(previous, snapshot, emit);
      if (
        snapshot.activity === "run" &&
        (snapshot.controller !== previous.controller ||
          (previous.phase === "takeover" && snapshot.phase === "running"))
      ) {
        emit(
          snapshot.controller === "user"
            ? "takeover-started"
            : "takeover-returned"
        );
      }
      setupChanges(previous, snapshot, emit);
      runVariableChanges(previous, snapshot, emit);
      if (snapshot.phase === "closed" && previous.phase !== "closed") {
        emit("session-closed");
      }
    }
    registry.set(atom, { ...log, snapshot });
  };
  const observeManifest = (
    id: AgentSessionId,
    manifest: TeachingRecordingManifest
  ) => {
    const atom = atomFor(id);
    let log = registry.get(atom);
    const receipts = new Set(log.receipts);
    for (const receipt of manifest.receipts) {
      const key = `${manifest.recordingId}:${receipt.operation}:${receipt.operationId}`;
      if (receipts.has(key)) {
        continue;
      }
      receipts.add(key);
      if (receipt.origin !== "workspace") {
        continue;
      }
      let kind: SessionEvent["kind"] | undefined;
      switch (receipt.operation) {
        case "verification": {
          kind = "flow-skill-verified";
          break;
        }
        case "reject": {
          kind = "flow-skill-rejected";
          break;
        }
        case "fail-dry-run": {
          if (
            receipt.eventKind === "dry-run-stopped" ||
            isStoppedDryRun(manifest)
          ) {
            kind = "dry-run-stopped";
          }
          break;
        }
        case "cleanup": {
          if (manifest.cleanup._tag === "purged") {
            kind = "cleanup-completed";
          }
          break;
        }
        default: {
          break;
        }
      }
      if (kind !== undefined) {
        log = append(log, kind, receipt.completedAt);
        if (kind === "flow-skill-verified") {
          log = { ...log, verifiedAt: receipt.completedAt };
        }
        if (kind === "cleanup-completed") {
          log = { ...log, cleanupCompleted: true };
        }
      }
    }
    const failure =
      manifest.cleanup._tag === "purge-pending"
        ? (manifest.cleanup.failure ?? undefined)
        : undefined;
    if (
      failure !== undefined &&
      log.cleanupFailure !== manifest.updatedAt &&
      manifest.eventOrigin === "workspace"
    ) {
      log = append(log, "cleanup-failed", manifest.updatedAt);
    }
    registry.set(atom, {
      ...log,
      cleanupFailure: failure === undefined ? undefined : manifest.updatedAt,
      receipts,
    });
  };
  const read = (id: AgentSessionId, afterCursor?: string) =>
    Effect.suspend(() => {
      const log = registry.get(atomFor(id));
      if (afterCursor === undefined) {
        return Effect.succeed({
          eventCursor: cursor(log),
          events: log.events.slice(0, 0),
          eventsTruncated: false,
        });
      }
      const prefix = `${log.epoch}:`;
      const sequence = Number(afterCursor.slice(prefix.length));
      if (
        !afterCursor.startsWith(prefix) ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        sequence > log.sequence ||
        `${prefix}${sequence}` !== afterCursor
      ) {
        return Effect.fail(
          agentSessionError(
            "agent_session_conflict",
            "Unknown Session Event cursor for this Agent Session."
          )
        );
      }
      const eventsTruncated = sequence < log.sequence - log.events.length;
      return Effect.succeed({
        eventCursor: cursor(log),
        events: eventsTruncated
          ? []
          : log.events.slice(sequence - (log.sequence - log.events.length)),
        eventsTruncated,
      });
    });
  const observeVerification = (
    id: AgentSessionId,
    at: string,
    origin: "agent" | "workspace"
  ) => {
    const atom = atomFor(id);
    let log = registry.get(atom);
    const key = `purged-verification:${at}`;
    if (log.receipts.has(key)) {
      return;
    }
    const receipts = new Set(log.receipts).add(key);
    // The manifest may already have delivered verification before deletion.
    if (origin === "workspace" && log.verifiedAt !== at) {
      log = { ...append(log, "flow-skill-verified", at), verifiedAt: at };
    }
    if (origin === "workspace" && !log.cleanupCompleted) {
      log = { ...append(log, "cleanup-completed", at), cleanupCompleted: true };
    }
    registry.set(atom, { ...log, receipts });
  };
  return { observe, observeManifest, observeVerification, read };
};
