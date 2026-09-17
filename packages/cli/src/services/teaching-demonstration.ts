import type {
  AgentBrowserSnapshot,
  AgentSnapshotId,
  CapturedAction,
  ScreenshotHash,
  TeachingInstruction,
  TeachingScreenshot,
  TeachingScreenshotContent,
  UrlTransition,
  Variable,
} from "@contingency/protocol";

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
  /** The bytes behind the screenshot references, addressed by content. */
  readonly screenshotContents: ReadonlyMap<
    ScreenshotHash,
    TeachingScreenshotContent
  >;
  readonly screenshots: readonly TeachingScreenshot[];
  readonly snapshots: ReadonlyMap<AgentSnapshotId, AgentBrowserSnapshot>;
  readonly urlTransitions: readonly UrlTransition[];
  readonly variables: readonly Variable[];
}

export const emptyDemonstration = (): Demonstration => ({
  actions: [],
  instructions: [],
  screenshotContents: new Map(),
  screenshots: [],
  snapshots: new Map(),
  urlTransitions: [],
  variables: [],
});

/** The host of a web URL, or nothing for `about:blank`, `data:`, and the like. */
export const webHost = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

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

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A bare hostname, or one explicit wildcard label at the front. */
export const isDomainScopeEntry = (entry: string): boolean => {
  const labels = entry.split(".");
  if (labels.length === 0 || labels.some((label) => label.length === 0)) {
    return false;
  }
  const [first, ...rest] = labels;
  const literal = first === "*" ? rest : labels;
  if (first === "*" && rest.length === 0) {
    return false;
  }
  return literal.every((label) => HOST_LABEL.test(label));
};

/**
 * Whether a Domain Scope entry covers a host. `*.example.com` covers every
 * subdomain and nothing else: a wildcard is explicit about what it adds, so it
 * does not quietly include the apex the user did not list.
 */
export const domainScopeCovers = (entry: string, host: string): boolean => {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return entry === host;
};
