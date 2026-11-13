import path from "node:path";

import { AgentRunId, CatalogRunSummary } from "@contingency/protocol";
import type {
  AgentSessionId,
  AgentTaskRunOutcome,
  AndroidWorkspaceSummary,
  FlowName,
  NativeAgentRunSummary,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";

import { AGENT_RUNS_DIRECTORY } from "./agent-run-store.ts";
import {
  maintainCatalogGitignore,
  resolveFlowDirectory,
} from "./flow-catalog-layout.ts";

/**
 * A native Run's identity. It names the device session that performed it, so
 * the Run Summary and the session's Workspace view point at each other.
 */
export const nativeRunId = (sessionId: AgentSessionId): AgentRunId =>
  AgentRunId.make(`agentrun-${sessionId}`);

/**
 * Where a native Run of a verified Flow keeps its evidence: under that Flow,
 * as the Run store files a single-Flow Run.
 */
export const nativeRunDirectory = (
  root: string,
  flowName: FlowName,
  sessionId: AgentSessionId,
  fs: FileSystem.FileSystem
) =>
  Effect.gen(function* locateNativeRun() {
    yield* maintainCatalogGitignore(root, fs);
    const flow = yield* resolveFlowDirectory(root, flowName, fs);
    return path.join(flow, AGENT_RUNS_DIRECTORY, nativeRunId(sessionId));
  });

const PLATFORM_LABEL = { android: "Android", ios: "iOS" } as const;
const KIND_LABEL = { "dry-run": "Dry Run", run: "Run" } as const;

/**
 * The Run Summary an ended native Run or Dry Run leaves, or `null` when the
 * session never ran: it never reached its first observation, or the user
 * refused its Run Environment Permission. Teaching produces a Teaching
 * Recording instead.
 */
export const nativeRunSummary = (input: {
  readonly endedAt: string;
  readonly outcome: AgentTaskRunOutcome;
  readonly platform: NativeAgentRunSummary["platform"];
  readonly ran: boolean;
  /** An Android or iOS session summary; both share these fields. */
  readonly summary: Pick<
    AndroidWorkspaceSummary,
    | "assessment"
    | "captureGaps"
    | "flowName"
    | "id"
    | "kind"
    | "phase"
    | "recordingId"
    | "requirements"
    | "startedAt"
    | "takeoverOccurred"
  >;
}): NativeAgentRunSummary | null => {
  const { summary } = input;
  if (
    summary.kind === "teaching" ||
    summary.phase === "refused" ||
    !input.ran
  ) {
    return null;
  }
  return {
    assessment: summary.assessment,
    captureGaps: summary.captureGaps,
    endedAt: input.endedAt,
    flowName: summary.flowName,
    kind: summary.kind,
    outcome: input.outcome,
    platform: input.platform,
    recordingId: summary.recordingId,
    requirements: summary.requirements,
    runId: nativeRunId(summary.id),
    schemaVersion: 4,
    sessionId: summary.id,
    startedAt: summary.startedAt,
    takeoverOccurred: summary.takeoverOccurred,
    title: `${PLATFORM_LABEL[input.platform]} ${KIND_LABEL[summary.kind]} · ${summary.flowName}`,
  };
};

const encodeSummary = Schema.encodeEffect(CatalogRunSummary);

/** Writes the Run Summary into the Run's own directory, atomically. */
export const writeNativeRunSummary = (
  fs: FileSystem.FileSystem,
  directory: string,
  summary: NativeAgentRunSummary
) =>
  Effect.gen(function* writeSummary() {
    const encoded = yield* encodeSummary(summary);
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(directory, "summary.json");
    yield* fs.writeFileString(
      `${file}.tmp`,
      `${JSON.stringify(encoded, null, 2)}\n`,
      { mode: 0o600 }
    );
    yield* fs.rename(`${file}.tmp`, file);
  });
