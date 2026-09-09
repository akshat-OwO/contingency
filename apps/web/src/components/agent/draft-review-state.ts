import type {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentSessionId,
  AgentFlowEvidenceSummary,
  AgentFlowHeads,
  AgentFlowManifest,
  AgentFlowRevisionStatus,
  AgentFlowVerification,
  AgentFlowVerificationStatus,
} from "@contingency/protocol";
import { Cause } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { AsyncResult } from "effect/unstable/reactivity";

import { retainedFamily } from "@/lib/retained-state";

export interface AuthorizationPresentation {
  /** Retained for presentation compatibility; Agent View never acts on it. */
  readonly action: string | undefined;
  /** Whether Agent View should explain that conversation approval is pending. */
  readonly canApprove: boolean;
  readonly detail: string;
  readonly status: AgentFlowVerificationStatus | "none";
}

/**
 * How Agent View describes the verification of one exact draft revision. An
 * authorization for another revision is not this draft's authorization, so a
 * corrected draft always reads as unauthorized.
 */
export const authorizationPresentation = ({
  revisionId,
  revisionStatus,
  verification,
}: {
  readonly revisionId: string;
  readonly revisionStatus: AgentFlowRevisionStatus;
  readonly verification: AgentFlowVerification | null;
}): AuthorizationPresentation => {
  // The passing Run stays on the record after approval, so what an approved
  // revision offers follows from the revision, not from its verification.
  if (revisionStatus === "approved") {
    return {
      action: undefined,
      canApprove: false,
      detail:
        "This revision is the Approved Agent Flow. It cannot be edited or approved again; a change creates a new draft.",
      status:
        verification?.revisionId === revisionId ? verification.status : "none",
    };
  }
  if (verification === null || verification.revisionId !== revisionId) {
    return {
      action: undefined,
      canApprove: false,
      detail:
        "Authorize or refuse this exact draft in your agent conversation. One authorization funds one Verification Run in a fresh browser.",
      status: "none",
    };
  }
  if (verification.status === "authorized") {
    return {
      action: undefined,
      canApprove: false,
      detail:
        "Verification is authorized for this draft. The agent can start the Run once.",
      status: "authorized",
    };
  }
  if (verification.status === "running") {
    return {
      action: undefined,
      canApprove: false,
      detail: "A Verification Run of this draft is in progress.",
      status: "running",
    };
  }
  if (verification.status === "passed") {
    return {
      action: undefined,
      canApprove: true,
      detail:
        verification.summary ??
        "This draft passed verification and is waiting for your approval.",
      status: "passed",
    };
  }
  return {
    action: undefined,
    canApprove: false,
    detail: `Verification failed: ${verification.summary ?? "the agent reported no explanation."} Any existing Approved Agent Flow is unchanged.`,
    status: "failed",
  };
};

/**
 * One slot per draft revision, so two reviews on screen never share state.
 */
const perRevision = <A>(initial: A) => {
  const family = retainedFamily<A>(initial);
  return (key: DraftReviewKey): Atom.Writable<A, A> =>
    family(`${key.agentFlowId}\u0000${key.revisionId}`);
};

/** Which draft revision one review is of. */
export interface DraftReviewKey {
  readonly agentFlowId: AgentFlowId;
  readonly revisionId: AgentFlowRevisionId;
}

/** What `agent.flow.revision.get` and every gesture answer with. */
export interface DraftRevisionDetail {
  readonly evidence: readonly AgentFlowEvidenceSummary[];
  readonly revision: {
    readonly heads: AgentFlowHeads;
    readonly manifest: AgentFlowManifest;
  };
}

/** Exact phrase the user types before Agent View enables permanent deletion. */
export const draftDeletionConfirmationAtom = perRevision<string>("");

/** The runtime Variable values typed into one Verification Run, by name. */
const variableDraftFamily = retainedFamily<Record<string, string>>({});

export const draftVariableDraftAtom = (
  sessionId: AgentSessionId
): Atom.Writable<Record<string, string>, Record<string, string>> =>
  variableDraftFamily(sessionId);

const successOf = <A>(
  result: AsyncResult.AsyncResult<A, unknown> | undefined
): AsyncResult.Success<A, unknown> | undefined =>
  result !== undefined && AsyncResult.isSuccess(result) ? result : undefined;

/**
 * The revision on show. A gesture answers with the revision the catalog now
 * holds and a reread answers with what it holds now, so the later answer is
 * the one that describes the draft.
 */
export const shownRevision = (
  read: AsyncResult.AsyncResult<
    { readonly data: DraftRevisionDetail },
    unknown
  >,
  gesture:
    | AsyncResult.AsyncResult<{ readonly data: DraftRevisionDetail }, unknown>
    | undefined
): DraftRevisionDetail | undefined => {
  const fromRead = successOf(read);
  const fromGesture = successOf(gesture);
  if (fromGesture === undefined) {
    return fromRead?.value.data;
  }
  if (fromRead === undefined) {
    return fromGesture.value.data;
  }
  return fromGesture.timestamp >= fromRead.timestamp
    ? fromGesture.value.data
    : fromRead.value.data;
};

/** Why the last thing the user asked for did not take effect. */
export const refusal = (
  result: AsyncResult.AsyncResult<unknown, unknown> | undefined
): string | undefined => {
  if (result === undefined || !AsyncResult.isFailure(result)) {
    return undefined;
  }
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : String(error);
};
