import {
  AgentActionResult,
  AgentBrowserSnapshot,
  AgentTimelineEntry,
} from "@contingency/protocol";
import { Predicate, Schema } from "effect";

/** Success schemas describe the agent projection, separately from stored evidence. */
export const McpBrowserSnapshot = Schema.Struct({
  ...AgentBrowserSnapshot.fields,
  capturedAt: Schema.optionalKey(AgentBrowserSnapshot.fields.capturedAt),
  nodes: Schema.optionalKey(AgentBrowserSnapshot.fields.nodes),
});
export const McpActionResult = Schema.Struct({
  ...AgentActionResult.fields,
  entry: Schema.Struct({
    ...AgentTimelineEntry.fields,
    actor: Schema.optionalKey(AgentTimelineEntry.fields.actor),
    description: Schema.optionalKey(AgentTimelineEntry.fields.description),
    dispatched: Schema.optionalKey(AgentTimelineEntry.fields.dispatched),
  }),
  snapshot: McpBrowserSnapshot,
  url: Schema.optionalKey(AgentActionResult.fields.url),
});

// Operation results have already passed Schema.Json validation. Classify containers
// without recursively validating each subtree again.
const isObject = (
  value: Schema.Json | undefined
): value is Record<string, Schema.Json> => Predicate.isObject(value);
const isString = Schema.is(Schema.String);

const compactSnapshot = (result: Record<string, Schema.Json>) => {
  // Snapshot identity distinguishes coverage and readiness from other domain fields.
  if (isString(result.snapshotId)) {
    if (
      isString(result.text) &&
      Array.isArray(result.nodes) &&
      result.nodes.length === 0
    ) {
      delete result.nodes;
    }
    const { coverage } = result;
    if (
      isObject(coverage) &&
      coverage.offset === 0 &&
      coverage.returned === coverage.total &&
      coverage.truncated === false &&
      coverage.nextCursor === null &&
      coverage.selector === null &&
      coverage.interactive !== true
    ) {
      delete result.coverage;
    }
    const { settle } = result;
    if (
      isObject(settle) &&
      settle.settled === true &&
      Array.isArray(settle.pending) &&
      settle.pending.length === 0
    ) {
      delete result.settle;
    }
  }
};

const compactAction = (
  result: Record<string, Schema.Json>,
  objective?: Schema.Json
) => {
  const { snapshot } = result;
  const { entry } = result;
  if (isObject(snapshot) && isString(snapshot.snapshotId)) {
    const snapshotCopy = { ...snapshot };
    result.snapshot = snapshotCopy;
    if (result.url === snapshot.url) {
      delete result.url;
    }
    if (isObject(entry)) {
      const entryCopy = { ...entry };
      result.entry = entryCopy;
      if (snapshot.capturedAt === entry.at) {
        delete snapshotCopy.capturedAt;
      }
      if (entry.description === objective) {
        delete entryCopy.description;
      }
      if (entry.actor === "agent") {
        delete entryCopy.actor;
        if (entry.dispatched === true) {
          delete entryCopy.dispatched;
        }
      }
    }
  }
};

/** Agent-only projection. Persisted evidence and Workspace keep the full protocol. */
export const compactMcpValue = (
  value: Schema.Json,
  objective?: Schema.Json
): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map((child) => compactMcpValue(child, objective));
  }
  if (!isObject(value)) {
    return value;
  }
  const result: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = compactMcpValue(child, objective);
  }
  compactSnapshot(result);
  if (
    Array.isArray(result.browserCheckResults) &&
    result.browserCheckResults.length === 0
  ) {
    delete result.browserCheckResults;
  }
  compactAction(result, objective);
  return result;
};
