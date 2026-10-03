import type {
  AgentBrowserSnapshot,
  AgentSnapshotId,
  CapturedAction,
  KeyframeHash,
  TeachingInstruction,
  TeachingKeyframe,
  TeachingKeyframeBytes,
  UrlTransition,
  Variable,
} from "@contingency/protocol";

import { webHost } from "./domain-scope.ts";

/**
 * Everything one Teaching session captured in memory, and the Domain Scope
 * helpers that read it.
 *
 * The record stays inside the owning process. A learning agent reads the
 * durable Teaching Recording — `events.jsonl`, keyframes, the paged semantic
 * timeline — not this value
 * ([ADR 0039](../../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
 */
export interface Demonstration {
  readonly actions: readonly CapturedAction[];
  readonly instructions: readonly TeachingInstruction[];
  /** The bytes behind the keyframe references, addressed by content. */
  readonly keyframeBytes: ReadonlyMap<KeyframeHash, TeachingKeyframeBytes>;
  readonly keyframes: readonly TeachingKeyframe[];
  readonly snapshots: ReadonlyMap<AgentSnapshotId, AgentBrowserSnapshot>;
  readonly urlTransitions: readonly UrlTransition[];
  readonly variables: readonly Variable[];
}

export const emptyDemonstration = (): Demonstration => ({
  actions: [],
  instructions: [],
  keyframeBytes: new Map(),
  keyframes: [],
  snapshots: new Map(),
  urlTransitions: [],
  variables: [],
});

export {
  domainScopeCovers,
  isDomainScopeEntry,
  webHost,
} from "./domain-scope.ts";

/** Exact hosts the Demonstration visited, sorted, for the proposed Domain Scope. */
export const observedHosts = (demonstration: Demonstration): string[] => {
  const hosts = new Set<string>();
  for (const action of demonstration.actions) {
    for (const url of [action.urlBefore, action.urlAfter]) {
      const host = webHost(url);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return [...hosts].toSorted();
};
