import { randomUUID } from "node:crypto";

import type {
  AgentActionIntent,
  AgentBrowserAction,
  AgentExecutionBoundary,
  AgentPendingDecision,
  AgentPendingDecisionResolve,
  AgentSessionId,
  BrowserRpcErrorType,
} from "@contingency/protocol";
import {
  AgentPendingDecisionId,
  makeBrowserRpcError,
} from "@contingency/protocol";
import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { domainScopeCovers, webHost } from "./domain-scope.ts";
import { sanitizeTeachingUrl } from "./sensitive-data.ts";

export interface BoundaryAttempt {
  readonly action: AgentBrowserAction;
  readonly capturedAction: AgentBrowserAction;
  readonly description: string;
  readonly intent: AgentActionIntent;
  readonly operationId: string;
  /** Latest requested task, or a historical Step's description. */
  readonly objective: string;
  /** Historical Runs retain their per-Step Confirmation markers. */
  readonly step:
    | { readonly index: number; readonly confirmation: boolean }
    | undefined;
}

export interface PendingBoundary {
  readonly boundary: AgentExecutionBoundary;
  readonly decision: AgentPendingDecision;
}

interface PendingAttempt extends PendingBoundary {
  readonly fingerprint: string;
}

export interface BoundaryCheck {
  readonly pending: PendingBoundary;
  readonly created: boolean;
}

interface BoundaryState {
  readonly hosts: ReadonlySet<string>;
  readonly grants: ReadonlySet<string>;
  readonly pending: PendingAttempt | undefined;
}

export interface ExecutionBoundary {
  readonly allows: (url: string) => boolean;
  readonly pending: () => PendingBoundary | undefined;
  readonly checkAttempt: (
    attempt: BoundaryAttempt
  ) => Effect.Effect<BoundaryCheck | undefined>;
  readonly checkNavigation: (
    url: string,
    operationId: string
  ) => Effect.Effect<BoundaryCheck | undefined>;
  readonly resolve: (
    input: AgentPendingDecisionResolve,
    paused: boolean
  ) => Effect.Effect<PendingBoundary, BrowserRpcErrorType>;
  readonly invalidateAttempts: () => void;
  readonly admitRequestedHosts: (
    hosts: readonly string[]
  ) => Effect.Effect<void, BrowserRpcErrorType>;
  readonly dispose: () => void;
}

const scopeSummary = (boundary: AgentExecutionBoundary): string => {
  if (boundary.reason === "domain") {
    return `Allow ${boundary.requested} for this Run. The saved Domain Scope stays unchanged.`;
  }
  const what =
    boundary.reason === "confirmation"
      ? "Confirm this irreversible or high-impact action attempt once"
      : "Allow this objective outside the requested task once";
  return `${what}: ${boundary.description} (${boundary.requested}). A retry needs another decision.`;
};

const hostAllowed = (hosts: ReadonlySet<string>, url: string): boolean => {
  const host = webHost(url);
  if (host === undefined) {
    return false;
  }
  for (const entry of hosts) {
    if (domainScopeCovers(entry, host)) {
      return true;
    }
  }
  return false;
};

/** Synchronous atom transitions keep interception and action dispatch on one policy state. */
export const makeExecutionBoundary = (options: {
  readonly hosts: readonly string[];
  readonly sessionId: AgentSessionId;
  readonly now: () => Date;
  readonly scope: "interactive" | "dry-run";
}): ExecutionBoundary => {
  const registry = AtomRegistry.make();
  let disposed = false;
  const state = Atom.make<BoundaryState>({
    grants: new Set<string>(),
    hosts: new Set(options.hosts.map((host) => host.toLowerCase())),
    pending: undefined,
  }).pipe(Atom.keepAlive);

  const pause = (
    current: BoundaryState,
    boundary: AgentExecutionBoundary,
    fingerprint: string
  ): [BoundaryCheck, BoundaryState] => {
    const pending: PendingAttempt = {
      boundary,
      decision: {
        boundaryId: boundary.id,
        createdAt: options.now().toISOString(),
        kind: "boundary",
        pendingDecisionId: AgentPendingDecisionId.make(
          `pending-${randomUUID()}`
        ),
        scopeSummary: scopeSummary(boundary),
        sessionId: options.sessionId,
        variable: null,
      },
      fingerprint,
    };
    return [
      { created: true, pending },
      { ...current, pending },
    ];
  };

  return {
    admitRequestedHosts: (hosts) =>
      options.scope === "dry-run" && hosts.length > 0
        ? Effect.fail(
            makeBrowserRpcError(
              "agent_session_invalid",
              "A Dry Run retains its Teaching hosts. Start a fresh Dry Run to change prerequisites."
            )
          )
        : Effect.sync(() =>
            registry.update(state, (current) => ({
              ...current,
              hosts: new Set([
                ...current.hosts,
                ...hosts.map((host) => host.toLowerCase()),
              ]),
            }))
          ),
    allows: (url) => !disposed && hostAllowed(registry.get(state).hosts, url),
    checkAttempt: (attempt) =>
      Effect.sync(() =>
        registry.modify(
          state,
          (current): [BoundaryCheck | undefined, BoundaryState] => {
            if (current.pending !== undefined) {
              return [{ created: false, pending: current.pending }, current];
            }
            const { action, intent, step } = attempt;
            const reasons: AgentExecutionBoundary["reason"][] = [];
            if (
              action.type === "navigate" &&
              !hostAllowed(current.hosts, action.url)
            ) {
              reasons.push("domain");
            }
            if (intent.objectiveKind === "new") {
              reasons.push("objective");
            }
            const mutating = ![
              "navigate",
              "hover",
              "scroll",
              "wait_for_text",
            ].includes(action.type);
            if (
              intent.irreversible === true ||
              (mutating && step?.confirmation === true)
            ) {
              reasons.push("confirmation");
            }
            if (reasons.length === 0) {
              return [undefined, current];
            }
            const fingerprint = JSON.stringify({
              action,
              intent,
              operationId: attempt.operationId,
              stepIndex: step?.index ?? null,
            });
            for (const reason of reasons) {
              if (!current.grants.has(reason + fingerprint)) {
                return pause(
                  current,
                  {
                    action: attempt.capturedAction,
                    description: attempt.description,
                    id: randomUUID(),
                    operationId: attempt.operationId,
                    reason,
                    requested:
                      reason === "domain" && action.type === "navigate"
                        ? sanitizeTeachingUrl(action.url)
                        : (intent.objective ?? attempt.objective),
                  },
                  fingerprint
                );
              }
            }
            const grants = new Set(current.grants);
            for (const reason of reasons) {
              grants.delete(reason + fingerprint);
            }
            return [undefined, { ...current, grants }];
          }
        )
      ),
    checkNavigation: (url, operationId) =>
      Effect.sync(() =>
        registry.modify(
          state,
          (current): [BoundaryCheck | undefined, BoundaryState] => {
            if (current.pending !== undefined) {
              return [{ created: false, pending: current.pending }, current];
            }
            if (hostAllowed(current.hosts, url)) {
              return [undefined, current];
            }
            const requested = sanitizeTeachingUrl(url);
            return pause(
              current,
              {
                action: { type: "navigate", url: requested },
                description: "Navigation outside the approved Domain Scope",
                id: randomUUID(),
                operationId,
                reason: "domain",
                requested,
              },
              "navigation"
            );
          }
        )
      ),
    dispose: () => {
      disposed = true;
      registry.dispose();
    },
    invalidateAttempts: () =>
      registry.update(state, (current) => ({
        ...current,
        grants: new Set<string>(),
      })),
    // Closed sessions remain in the session registry for historical reads.
    pending: () => (disposed ? undefined : registry.get(state).pending),
    resolve: (input, paused) =>
      Effect.gen(function* resolveBoundary() {
        const current = registry.get(state);
        const { pending } = current;
        if (
          pending === undefined ||
          pending.decision.pendingDecisionId !== input.pendingDecisionId
        ) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_session_conflict",
              "This boundary request is no longer pending."
            )
          );
        }
        const allowed = input.decision === "allow";
        if (!(allowed || input.decision === "refuse")) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_session_conflict",
              `Pending decision ${input.pendingDecisionId} accepts allow or refuse, not ${input.decision}.`
            )
          );
        }
        if (allowed && paused) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_control_unavailable",
              "Return control before confirming an agent attempt. The user holds the browser; agent actions resume when the user returns control."
            )
          );
        }
        const hosts = new Set(current.hosts);
        const grants = new Set(current.grants);
        if (allowed) {
          if (pending.boundary.reason === "domain") {
            const host = webHost(pending.boundary.requested);
            if (host === undefined) {
              return yield* Effect.fail(
                makeBrowserRpcError(
                  "agent_session_invalid",
                  "Only HTTP and HTTPS domains can be approved."
                )
              );
            }
            hosts.add(host);
          } else {
            grants.add(pending.boundary.reason + pending.fingerprint);
          }
        }
        registry.set(state, { grants, hosts, pending: undefined });
        return pending;
      }),
  };
};
