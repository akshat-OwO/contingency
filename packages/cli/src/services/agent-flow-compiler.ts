import type {
  AgentBrowserSnapshot,
  AgentFlowDiagnostic,
  AgentFlowDraftProposal,
  AgentSnapshotId,
  CapturedAction,
  EvidenceSlice,
  ScreenshotHash,
  TeachingInstruction,
  TeachingScreenshot,
  TeachingScreenshotContent,
  UrlTransition,
  Variable,
} from "@contingency/protocol";
import { Result } from "effect";

/**
 * Everything Teaching captured for one Agent Session. It is compilation input
 * and stays inside the owning process; the external agent reads the bounded
 * Teaching Feed derived from it, never this record.
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

const hostsOf = (actions: readonly CapturedAction[]): string[] => {
  const hosts = new Set<string>();
  for (const action of actions) {
    for (const url of [action.urlBefore, action.urlAfter]) {
      const host = webHost(url);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return [...hosts].toSorted();
};

/** Exact hosts the Demonstration visited, sorted, for the proposed Domain Scope. */
export const observedHosts = (demonstration: Demonstration): string[] =>
  hostsOf(demonstration.actions);

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

const diagnostic = (
  code: string,
  message: string,
  path: readonly (string | number)[]
): AgentFlowDiagnostic => ({ code, message, path: [...path] });

const timeOf = (at: string): number => Date.parse(at);

interface ResolvedSpan {
  readonly actions: readonly CapturedAction[];
  readonly first: number;
  readonly last: number;
}

const resolveSpans = (
  proposal: AgentFlowDraftProposal,
  demonstration: Demonstration
): {
  readonly diagnostics: AgentFlowDiagnostic[];
  readonly spans: ResolvedSpan[];
} => {
  const indexById = new Map(
    demonstration.actions.map((action, index) => [action.id, index] as const)
  );
  const diagnostics: AgentFlowDiagnostic[] = [];
  const spans: ResolvedSpan[] = [];
  let previousLast = -1;
  for (const [stepIndex, step] of proposal.steps.entries()) {
    const first = indexById.get(step.firstActionId);
    const last = indexById.get(step.lastActionId);
    if (first === undefined) {
      diagnostics.push(
        diagnostic(
          "unknown_action",
          `Action ${step.firstActionId} was not captured in this Demonstration.`,
          ["steps", stepIndex, "firstActionId"]
        )
      );
    }
    if (last === undefined) {
      diagnostics.push(
        diagnostic(
          "unknown_action",
          `Action ${step.lastActionId} was not captured in this Demonstration.`,
          ["steps", stepIndex, "lastActionId"]
        )
      );
    }
    if (first === undefined || last === undefined) {
      continue;
    }
    if (last < first) {
      diagnostics.push(
        diagnostic(
          "inverted_span",
          `Step ${stepIndex} ends at ${step.lastActionId}, which was captured before ${step.firstActionId}.`,
          ["steps", stepIndex]
        )
      );
      continue;
    }
    if (first <= previousLast) {
      diagnostics.push(
        diagnostic(
          "overlapping_span",
          `Step ${stepIndex} starts at ${step.firstActionId}, which an earlier Step already covers. Agent Steps are ordered and disjoint.`,
          ["steps", stepIndex, "firstActionId"]
        )
      );
      continue;
    }
    const actions = demonstration.actions.slice(first, last + 1);
    if (!actions.some((action) => action.outcome === "completed")) {
      diagnostics.push(
        diagnostic(
          "no_completed_action",
          `Step ${stepIndex} covers no completed action, so there is no evidence it was achieved.`,
          ["steps", stepIndex]
        )
      );
    }
    previousLast = last;
    spans.push({ actions, first, last });
  }
  return { diagnostics, spans };
};

const validateDomainScope = (
  proposal: AgentFlowDraftProposal,
  covered: readonly string[]
): AgentFlowDiagnostic[] => {
  const diagnostics: AgentFlowDiagnostic[] = [];
  const entries = proposal.domainScope.hosts.map((host) => host.toLowerCase());
  for (const [index, entry] of entries.entries()) {
    if (!isDomainScopeEntry(entry)) {
      diagnostics.push(
        diagnostic(
          "invalid_domain",
          `"${proposal.domainScope.hosts[index]}" is not a hostname or a *.example.com pattern.`,
          ["domainScope", "hosts", index]
        )
      );
      continue;
    }
    if (!covered.some((host) => domainScopeCovers(entry, host))) {
      diagnostics.push(
        diagnostic(
          "unobserved_domain",
          `The Demonstration never visited a host covered by "${entry}". Teaching proposes only observed hosts.`,
          ["domainScope", "hosts", index]
        )
      );
    }
  }
  const valid = entries.filter(isDomainScopeEntry);
  for (const host of covered) {
    if (!valid.some((entry) => domainScopeCovers(entry, host))) {
      diagnostics.push(
        diagnostic(
          "uncovered_host",
          `The demonstrated Steps visit ${host}, which no Domain Scope entry covers.`,
          ["domainScope", "hosts"]
        )
      );
    }
  }
  return diagnostics;
};

const validateUnique = (
  values: readonly string[] | undefined,
  path: string,
  code: string,
  label: string
): AgentFlowDiagnostic[] => {
  if (values === undefined) {
    return [];
  }
  const seen = new Set<string>();
  const diagnostics: AgentFlowDiagnostic[] = [];
  for (const [index, value] of values.entries()) {
    const key = value.trim().toLowerCase();
    if (seen.has(key)) {
      diagnostics.push(
        diagnostic(code, `${label} "${value}" is declared twice.`, [
          path,
          index,
        ])
      );
    }
    seen.add(key);
  }
  return diagnostics;
};

const validateDemonstratedVariables = (
  proposal: AgentFlowDraftProposal,
  demonstration: Demonstration
): AgentFlowDiagnostic[] => {
  const diagnostics: AgentFlowDiagnostic[] = [];
  for (const variable of demonstration.variables) {
    const proposed = proposal.variables?.find(
      ({ name }) => name === variable.name
    );
    if (proposed === undefined) {
      diagnostics.push(
        diagnostic(
          "missing_variable",
          `The Demonstration uses Variable ${variable.name}, but the draft does not declare it.`,
          ["variables"]
        )
      );
      continue;
    }
    if (
      proposed.runtime !== variable.runtime ||
      proposed.secret !== variable.secret
    ) {
      diagnostics.push(
        diagnostic(
          "variable_mismatch",
          `Variable ${variable.name} must keep the secret and runtime properties demonstrated by the user.`,
          ["variables"]
        )
      );
    }
  }
  return diagnostics;
};

/** The directory inside an Agent Flow package that holds screenshot bytes. */
export const SCREENSHOTS_DIRECTORY = "screenshots";

/** Where one screenshot's bytes live, relative to the Agent Flow directory. */
export const evidenceScreenshotPath = (contentHash: ScreenshotHash): string =>
  `${SCREENSHOTS_DIRECTORY}/${contentHash}.png`;

const between = (
  at: string,
  afterExclusive: number,
  untilInclusive: number
) => {
  const time = timeOf(at);
  return time > afterExclusive && time <= untilInclusive;
};

const sliceFor = (
  proposal: AgentFlowDraftProposal,
  demonstration: Demonstration,
  span: ResolvedSpan,
  stepIndex: number,
  previousEnd: number
): EvidenceSlice => {
  const step = proposal.steps[stepIndex];
  if (step === undefined) {
    throw new Error(`Step ${stepIndex} has no proposal.`);
  }
  const [first] = span.actions;
  const last = span.actions.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(`Step ${stepIndex} resolved to an empty span.`);
  }
  const endedAt = timeOf(last.at);
  const actionIds = new Set(span.actions.map((action) => action.id));
  const lookup = (id: AgentSnapshotId | null): AgentBrowserSnapshot | null =>
    id === null ? null : (demonstration.snapshots.get(id) ?? null);
  return {
    actions: span.actions,
    after: lookup(last.snapshotAfter),
    before: lookup(first.snapshotBefore),
    endedAt: last.at,
    // The instructions in force for this objective: everything said since the
    // previous Step ended and before this one did. An instruction given
    // before any action belongs to the first Step.
    instructions: demonstration.instructions.filter(({ at }) =>
      between(at, previousEnd, endedAt)
    ),
    schemaVersion: 2,
    // The slice names where the bytes live in the package rather than
    // carrying them: one screenshot two Steps both cite is stored once.
    screenshots: demonstration.screenshots
      .filter(({ capturedAt }) => between(capturedAt, previousEnd, endedAt))
      .map((screenshot) => ({
        ...screenshot,
        path: evidenceScreenshotPath(screenshot.contentHash),
      })),
    startedAt: first.at,
    urlTransitions: demonstration.urlTransitions.filter(
      (transition) =>
        (transition.actionId !== null && actionIds.has(transition.actionId)) ||
        (transition.actionId === null &&
          between(transition.at, previousEnd, endedAt))
    ),
  };
};

/**
 * Turn compiler output into Evidence Slices, or refuse it with structured
 * diagnostics. Nothing here writes to the catalog: invalid output never
 * reaches it ([ADR 0025](../../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 */
export const compileAgentFlowDraft = (
  proposal: AgentFlowDraftProposal,
  demonstration: Demonstration
): Result.Result<readonly EvidenceSlice[], readonly AgentFlowDiagnostic[]> => {
  const { diagnostics, spans } = resolveSpans(proposal, demonstration);
  const collected = [
    ...diagnostics,
    ...validateUnique(proposal.tags, "tags", "duplicate_tag", "Tag"),
    ...validateUnique(
      proposal.variables?.map(({ name }) => name),
      "variables",
      "duplicate_variable",
      "Variable"
    ),
    ...validateDemonstratedVariables(proposal, demonstration),
  ];
  // Domain Scope is judged against the hosts the compiled Steps actually
  // visit. Exploration the agent left out of every span is not part of the
  // journey and must not widen it.
  if (diagnostics.length === 0) {
    collected.push(
      ...validateDomainScope(
        proposal,
        hostsOf(spans.flatMap(({ actions }) => actions))
      )
    );
  }
  if (collected.length > 0) {
    return Result.fail(collected);
  }
  const slices: EvidenceSlice[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [stepIndex, span] of spans.entries()) {
    const slice = sliceFor(
      proposal,
      demonstration,
      span,
      stepIndex,
      previousEnd
    );
    previousEnd = timeOf(slice.endedAt);
    slices.push(slice);
  }
  return Result.succeed(slices);
};
