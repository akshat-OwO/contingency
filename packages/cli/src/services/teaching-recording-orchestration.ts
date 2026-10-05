import { createHash } from "node:crypto";
import path from "node:path";

import { AgentRunId } from "@contingency/protocol";
import type {
  AgentRunTaskInput,
  AgentSessionSnapshot,
  FlowSkillFile,
  FlowSkillName,
  OperationId,
  TaskAgentRunState,
  TeachingRecordingId,
  TeachingRecordingManifest,
  TeachingRecordingSummary,
} from "@contingency/protocol";
import { Effect, FileSystem, Option } from "effect";

import { AgentSession } from "./agent-session.ts";
import { markDemoWork } from "./demo-site.ts";
import { webHost } from "./domain-scope.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import {
  PRIVATE_INPUT_NAME,
  readRequestedSkills,
  taskVariables,
  validateTaskInputs,
} from "./requested-flow-skills.ts";
import { requestedScans } from "./scan-requirements.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";
import type { TeachingRecordingMutation } from "./teaching-recording-store.ts";

/**
 * Teaching Recording orchestration: the sequences that span the durable store,
 * the Flow Skill catalog, and the Agent Session that runs a Dry Run.
 *
 * The store owns each durable transition, its cross-process lock, and its
 * receipt. This module owns the order of those transitions — Dry Run startup
 * under [ADR 0047](../../../../docs/adr/0047-dry-run-prerequisites-are-fixed-at-startup.md),
 * a Dry Run stop, and verification followed by Cleanup — so the MCP and RPC
 * adapters only translate requests and outcomes.
 */

export interface TeachingRecordingOrchestrationError {
  readonly _tag: "TeachingRecordingOrchestrationError";
  readonly code: string;
  readonly message: string;
}

const orchestrationError = (
  code: string,
  message: string
): TeachingRecordingOrchestrationError => ({
  _tag: "TeachingRecordingOrchestrationError",
  code,
  message,
});

const fromCause = (cause: {
  readonly code: string;
  readonly message: string;
}): TeachingRecordingOrchestrationError =>
  orchestrationError(cause.code, cause.message);

/**
 * The one recording summary projection. States before Stop carry no learning
 * state, so they have no summary.
 */
export const teachingRecordingSummary = (
  manifest: TeachingRecordingManifest
): TeachingRecordingSummary | undefined => {
  const { lifecycle } = manifest;
  const summary = (failure: string | null) => ({
    cleanup: manifest.cleanup,
    emulation: manifest.emulation,
    failure,
    flowSkillName: manifest.flowSkillName,
    lifecycle: lifecycle._tag,
    recordingId: manifest.recordingId,
    updatedAt: manifest.updatedAt,
  });
  switch (lifecycle._tag) {
    case "recording":
    case "ready":
    case "learning":
    case "skill-drafted":
    case "dry-running":
    case "dry-run-passed":
    case "verified": {
      return { ...summary(null), lifecycle: lifecycle._tag };
    }
    case "dry-run-failed": {
      return {
        ...summary(lifecycle.dryRunResult.observableOutcome),
        lifecycle: lifecycle._tag,
      };
    }
    case "failed": {
      return { ...summary(lifecycle.error), lifecycle: lifecycle._tag };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The publishing process refreshes its session snapshot from the manifest it
 * just changed. Another process's session is not visible here, so a miss is
 * ignored.
 */
const refreshSession = (manifest: TeachingRecordingManifest) =>
  Effect.serviceOption(AgentSession).pipe(
    Effect.flatMap((sessions) =>
      Option.isSome(sessions)
        ? sessions.value
            .observeSessionManifest(manifest)
            .pipe(
              Effect.andThen(sessions.value.get(manifest.sessionId)),
              Effect.ignore
            )
        : Effect.void
    )
  );

export type FlowSkillDecision = "reject" | "retry-cleanup" | "verify";

export interface FlowSkillDecisionInput extends TeachingRecordingMutation {
  readonly decision: FlowSkillDecision;
}

/**
 * Relay the user's decision about a Flow Skill whose Dry Run passed, or resume
 * Cleanup for one already verified.
 *
 * Verification purges in two durable halves: the verified transition lands
 * first, then deletion runs. A retry re-enters only the second half, so a
 * failed deletion never rolls the Flow Skill back.
 */
export const decideFlowSkill = (input: FlowSkillDecisionInput) =>
  Effect.gen(function* decide() {
    const store = yield* TeachingRecordingStore;
    const mutation = {
      operationId: input.operationId,
      recordingId: input.recordingId,
    };
    if (input.decision === "reject") {
      const rejected = yield* store.reject(mutation);
      yield* refreshSession(rejected);
      return rejected;
    }
    if (input.decision === "verify") {
      const verified = yield* store.verify(mutation);
      yield* refreshSession(verified);
    }
    const cleaned = yield* store.cleanup(mutation);
    yield* refreshSession(cleaned);
    return cleaned;
  });

/**
 * Stop a running Dry Run on the user's behalf.
 *
 * The stop is persisted before the browser is touched. The store mutation is
 * the only lock the processes share, so a passing report or a verification
 * that lands first wins and Stop reports the conflict instead of killing a
 * Dry Run the user already accepted.
 */
export const stopDryRun = (input: TeachingRecordingMutation) =>
  Effect.gen(function* stop() {
    const store = yield* TeachingRecordingStore;
    const manifest: TeachingRecordingManifest = yield* store.failDryRun({
      ...input,
      observableOutcome: "The user stopped the Dry Run before it completed.",
    });
    yield* refreshSession(manifest);
    const { lifecycle } = manifest;
    if (lifecycle._tag === "dry-run-failed") {
      // Only the process that started the Dry Run owns its session. Closing
      // here covers a process that owns it; the starting process closes its
      // own once the manifest leaves dry-running.
      const sessions = yield* Effect.serviceOption(AgentSession);
      if (Option.isSome(sessions)) {
        yield* sessions.value
          .completeRun(lifecycle.dryRunSessionId)
          .pipe(Effect.ignore);
      }
    }
    return manifest;
  });

export type DryRunInput =
  | {
      readonly changed: boolean;
      readonly name: string;
      readonly secret: false;
      readonly value: string;
    }
  | {
      readonly changed: boolean;
      readonly name: string;
      readonly secret: true;
    };

export interface DryRunStartInput extends TeachingRecordingMutation {
  readonly inputs: readonly DryRunInput[];
  readonly prerequisiteInputs: readonly AgentRunTaskInput[];
  readonly prerequisites: readonly FlowSkillName[];
  readonly url: string;
}

export interface DryRunStarted {
  readonly files: readonly FlowSkillFile[];
  readonly manifest: TeachingRecordingManifest;
  readonly prerequisites: readonly {
    readonly files: readonly FlowSkillFile[];
    readonly flowSkillName: FlowSkillName;
  }[];
  readonly session: AgentSessionSnapshot;
  readonly skillPath: string;
}

const conflict = (message: string) =>
  orchestrationError("teaching_recording_conflict", message);

const invalid = (message: string) =>
  orchestrationError("teaching_recording_invalid", message);

/** The run identity is derived so a replayed start rebuilds the same Run. */
const dryRunId = (
  recordingId: TeachingRecordingId,
  operationId: OperationId
): AgentRunId =>
  AgentRunId.make(
    `agentrun-${createHash("sha256")
      .update(`${recordingId}:${operationId}`)
      .digest("hex")
      .slice(0, 32)}`
  );

/**
 * Start a saved Flow Skill's Dry Run in a fresh browser context.
 *
 * Prerequisites and their ordinary inputs are fixed here and become part of
 * the start request, so a replay that changes either conflicts with the first
 * start instead of rebuilding a different Run (ADR 0047). Inputs stay scoped
 * to the skill that declares them, and the Domain Scope stays the Teaching
 * hosts.
 */
export const startDryRun = (input: DryRunStartInput) =>
  // oxlint-disable-next-line eslint/complexity
  Effect.gen(function* startFlowSkillDryRun() {
    const store = yield* TeachingRecordingStore;
    const sessions = yield* AgentSession;
    const catalog = yield* FlowSkillCatalog;
    const fileSystem = yield* FileSystem.FileSystem;
    const manifest = yield* store
      .read(input.recordingId)
      .pipe(Effect.mapError(fromCause));
    const replay = manifest.receipts.some(
      (receipt) =>
        receipt.operation === "start-dry-run" &&
        receipt.operationId === input.operationId
    );
    if (
      manifest.lifecycle._tag !== "skill-drafted" &&
      manifest.lifecycle._tag !== "dry-run-failed" &&
      !replay
    ) {
      return yield* Effect.fail(
        conflict(
          `Teaching Recording ${input.recordingId} cannot start a Dry Run from ${manifest.lifecycle._tag}.`
        )
      );
    }
    if (!("skillPath" in manifest.lifecycle)) {
      return yield* Effect.fail(
        conflict("The Teaching Recording has no saved Flow Skill package.")
      );
    }
    const { skillPath } = manifest.lifecycle;
    // The package lives under the Catalog Root that holds the recording, which
    // may not be the root this process selected since.
    const recordingCatalogRoot = path.dirname(
      path.dirname(store.directory(manifest.recordingId))
    );
    const skill = yield* catalog
      .read(manifest.flowSkillName, recordingCatalogRoot)
      .pipe(
        Effect.mapError((cause) =>
          orchestrationError(
            "teaching_recording_io",
            `Could not read the Flow Skill package: ${cause.message}`
          )
        )
      );
    if (skill.steps.length === 0) {
      return yield* Effect.fail(
        invalid("The Flow Skill has no numbered steps to assess.")
      );
    }
    const host = webHost(input.url);
    const { hosts } = skill;
    if (host === undefined || !hosts.includes(host)) {
      return yield* Effect.fail(
        invalid(
          `The Dry Run must start on one of the Teaching Recording's visited hosts: ${hosts.join(", ")}.`
        )
      );
    }
    const names = new Set(input.inputs.map(({ name }) => name));
    if (
      names.size !== input.inputs.length ||
      names.size !== skill.inputs.length ||
      skill.inputs.some(({ name }) => !names.has(name))
    ) {
      return yield* Effect.fail(
        invalid(
          "Dry Run inputs must name every declared Flow Skill input exactly once."
        )
      );
    }
    const secretNames = input.inputs.flatMap((entry) =>
      entry.secret ? [entry.name.toUpperCase()] : []
    );
    if (
      secretNames.some((name) => !PRIVATE_INPUT_NAME.test(name)) ||
      new Set(secretNames).size !== secretNames.length
    ) {
      return yield* Effect.fail(
        invalid(
          "Secret input names must map uniquely to uppercase Variable names."
        )
      );
    }
    /*
      A secret input is named and never valued: the Dry Run session snapshot
      reaches the Workspace, so the literal stops here (ADR 0039).
    */
    const dryRunInputs = input.inputs.map((entry) => ({
      changed: entry.changed,
      name: entry.name,
      value: entry.secret ? null : entry.value,
    }));
    if (
      new Set(input.prerequisites).size !== input.prerequisites.length ||
      input.prerequisites.includes(manifest.flowSkillName)
    ) {
      return yield* Effect.fail(
        invalid(
          "Dry Run prerequisites must be distinct verified skills other than the tested skill."
        )
      );
    }
    const prerequisites = yield* readRequestedSkills(input.prerequisites).pipe(
      Effect.mapError(fromCause)
    );
    yield* validateTaskInputs(prerequisites, input.prerequisiteInputs).pipe(
      Effect.mapError(fromCause)
    );
    const unsupplied = prerequisites.find((prerequisite) =>
      prerequisite.inputs.some(
        (declared) =>
          !PRIVATE_INPUT_NAME.test(declared.name) &&
          !input.prerequisiteInputs.some(
            (supplied) =>
              supplied.flowSkillName === prerequisite.name &&
              supplied.name === declared.name
          )
      )
    );
    if (unsupplied !== undefined) {
      return yield* Effect.fail(
        invalid(
          `Supply every ordinary prerequisite input for ${unsupplied.name} at Dry Run startup.`
        )
      );
    }
    const startedAt = new Date().toISOString();
    const run: TaskAgentRunState = markDemoWork(hosts, {
      assessment: null,
      attribution: {
        clientName: "flow-skill-dry-run",
        clientVersion: "1",
        reportedMetadataVerified: false,
        reportedModel: null,
        reportedProvider: null,
      },
      findings: [],
      inputs: [
        ...input.prerequisiteInputs,
        ...dryRunInputs.flatMap(({ name, value }) =>
          value === null
            ? []
            : [{ flowSkillName: manifest.flowSkillName, name, value }]
        ),
      ],
      instructions: [],
      lastAgentActivityAt: startedAt,
      lifecycle: { phase: "running" },
      purpose: {
        flowSkillName: manifest.flowSkillName,
        kind: "dry-run",
        recordingId: manifest.recordingId,
        takeoverOccurred: false,
      },
      referencedSkills: [
        { flowSkillName: manifest.flowSkillName, referencedAt: startedAt },
        ...prerequisites.map((prerequisite) => ({
          flowSkillName: prerequisite.name,
          referencedAt: startedAt,
        })),
      ],
      requestedTask: skill.title,
      runId: dryRunId(input.recordingId, input.operationId),
      scanReports: [],
      scanRequirements: yield* requestedScans([skill, ...prerequisites]).pipe(
        Effect.mapError((cause) => invalid(cause.message))
      ),
      schemaVersion: 3,
      startedAt,
      startingEmulation: manifest.emulation,
      title: manifest.flowSkillName,
      variables: [
        ...prerequisites.flatMap(taskVariables),
        ...secretNames.map((name) => ({
          flowSkillName: manifest.flowSkillName,
          name,
          runtime: true,
          secret: true,
          supplied: false,
        })),
      ],
    });
    const evidenceDirectory = path.join(
      store.directory(manifest.recordingId),
      "dry-run"
    );
    // The previous evidence is replaced only for a new start: a retry replays
    // its session, and a changed request conflicts before it.
    const prepare = Effect.gen(function* prepareDryRun() {
      if (!replay) {
        yield* fileSystem
          .remove(evidenceDirectory, { force: true, recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              orchestrationError(
                "teaching_recording_io",
                `Could not replace the previous Dry Run evidence: ${cause.message}`
              )
            )
          );
      }
      return {
        activity: "run" as const,
        artifactDirectory: evidenceDirectory,
        clientName: "flow-skill-dry-run",
        clientVersion: "1",
        domainScope: { hosts },
        dryRun: {
          flowSkillName: manifest.flowSkillName,
          inputs: dryRunInputs,
          recordingId: manifest.recordingId,
          variables: secretNames.map((name) => ({
            name,
            runtime: true,
            secret: true,
            supplied: false,
          })),
        },
        emulation: manifest.emulation,
        run,
        url: input.url,
        viewport: manifest.emulation.viewport,
      };
    });
    const session = yield* sessions
      .startPrepared(
        {
          operationId: input.operationId,
          request: JSON.stringify({
            activity: "flow-skill-dry-run",
            inputs: input.inputs,
            prerequisiteInputs: input.prerequisiteInputs,
            prerequisites: input.prerequisites,
            recordingId: input.recordingId,
            url: input.url,
          }),
        },
        prepare
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "TeachingRecordingOrchestrationError"
            ? cause
            : fromCause(cause)
        )
      );
    const started = yield* store
      .startDryRun({
        inputs: dryRunInputs,
        operationId: input.operationId,
        recordingId: input.recordingId,
        sessionId: session.id,
      })
      .pipe(
        Effect.tapError(() =>
          sessions.close(session.id, input.operationId).pipe(Effect.ignore)
        ),
        Effect.mapError(fromCause)
      );
    if (started.lifecycle._tag !== "dry-running" && !replay) {
      return yield* Effect.die("A started Dry Run did not enter dry-running.");
    }
    yield* sessions.get(started.sessionId).pipe(Effect.ignore);
    // An Agent Session lives in the process that started it, so a Stop from
    // the Workspace can only persist the transition. This process watches the
    // durable manifest and closes its own Chromium once the Dry Run leaves
    // dry-running, whichever process ended it.
    if (!replay) {
      yield* Effect.forkDetach(
        Effect.sleep("1 second").pipe(
          Effect.andThen(store.read(input.recordingId)),
          Effect.map((current) => current.lifecycle._tag !== "dry-running"),
          Effect.catchCause(() => Effect.succeed(true)),
          Effect.repeat({ until: (ended: boolean) => ended }),
          Effect.andThen(sessions.completeRun(session.id).pipe(Effect.ignore))
        )
      );
    }
    return {
      files: skill.files,
      manifest: started,
      prerequisites: prerequisites.map((prerequisite) => ({
        files: prerequisite.files,
        flowSkillName: prerequisite.name,
      })),
      session,
      skillPath,
    } satisfies DryRunStarted;
  });
