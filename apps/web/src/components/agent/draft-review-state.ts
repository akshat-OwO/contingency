import type {
  AgentFlowDraftProposal,
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

/**
 * One Agent Step as the user is editing it. Corrections move the demonstrated
 * span boundaries; they never author evidence, because Contingency derives
 * every Evidence Slice from the span the corrected proposal names.
 */
export interface DraftStepEdit {
  readonly confirmation: boolean;
  readonly description: string;
  readonly firstActionId: string;
  readonly lastActionId: string;
  readonly name: string;
}

export interface DraftReviewEdit {
  readonly hosts: readonly string[];
  readonly steps: readonly DraftStepEdit[];
}

export const draftEditFromManifest = (
  manifest: AgentFlowManifest
): DraftReviewEdit => ({
  hosts: [...manifest.domainScope.hosts],
  steps: manifest.steps.map((step) => ({
    confirmation: step.confirmation,
    description: step.description,
    firstActionId: step.firstActionId,
    lastActionId: step.lastActionId,
    name: step.name,
  })),
});

/**
 * Merge one Step into the one after it. The spans are adjacent and ordered, so
 * the merged objective covers both and keeps the earlier Step's name — which
 * the user then clarifies.
 */
export const mergeStepWithNext = (
  edit: DraftReviewEdit,
  index: number
): DraftReviewEdit => {
  const step = edit.steps[index];
  const next = edit.steps[index + 1];
  if (step === undefined || next === undefined) {
    return edit;
  }
  const merged: DraftStepEdit = {
    confirmation: step.confirmation || next.confirmation,
    description: `${step.description} ${next.description}`,
    firstActionId: step.firstActionId,
    lastActionId: next.lastActionId,
    name: step.name,
  };
  return {
    ...edit,
    steps: [
      ...edit.steps.slice(0, index),
      merged,
      ...edit.steps.slice(index + 2),
    ],
  };
};

/**
 * Split one Step so the named action starts a second objective. The action
 * must be inside the Step and not its first, because a Step always covers at
 * least one demonstrated action.
 */
export const splitStepAt = (
  edit: DraftReviewEdit,
  index: number,
  actionIds: readonly string[],
  actionId: string
): DraftReviewEdit => {
  const step = edit.steps[index];
  const at = actionIds.indexOf(actionId);
  const previous = actionIds[at - 1];
  if (step === undefined || at <= 0 || previous === undefined) {
    return edit;
  }
  const first: DraftStepEdit = { ...step, lastActionId: previous };
  const second: DraftStepEdit = {
    ...step,
    firstActionId: actionId,
    name: `${step.name} (continued)`,
  };
  return {
    ...edit,
    steps: [
      ...edit.steps.slice(0, index),
      first,
      second,
      ...edit.steps.slice(index + 1),
    ],
  };
};

export const editStep = (
  edit: DraftReviewEdit,
  index: number,
  patch: Partial<Omit<DraftStepEdit, "firstActionId" | "lastActionId">>
): DraftReviewEdit => ({
  ...edit,
  steps: edit.steps.map((step, at) =>
    at === index ? { ...step, ...patch } : step
  ),
});

export const editHosts = (
  edit: DraftReviewEdit,
  hosts: readonly string[]
): DraftReviewEdit => ({ ...edit, hosts: [...hosts] });

/** Split a textarea of hosts into entries, dropping blank lines. */
export const parseHosts = (value: string): readonly string[] =>
  value
    .split(/[\n,]/u)
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

/** The corrected proposal, in exactly the shape the compiler produces. */
export const draftProposalFrom = (
  manifest: AgentFlowManifest,
  edit: DraftReviewEdit
): AgentFlowDraftProposal => ({
  description: manifest.description,
  domainScope: { hosts: edit.hosts },
  schemaVersion: 1,
  steps: edit.steps.map((step) => ({
    confirmation: step.confirmation,
    description: step.description,
    firstActionId: step.firstActionId,
    lastActionId: step.lastActionId,
    name: step.name,
  })),
  tags: manifest.tags,
  title: manifest.title,
  variables: manifest.variables,
});

/** Whether the user has changed anything the draft would be re-saved for. */
export const draftIsEdited = (
  manifest: AgentFlowManifest,
  edit: DraftReviewEdit
): boolean =>
  JSON.stringify(
    draftProposalFrom(manifest, draftEditFromManifest(manifest))
  ) !== JSON.stringify(draftProposalFrom(manifest, edit));

/** One captured action as the evidence summaries describe it. */
export type DemonstratedAction = AgentFlowEvidenceSummary["actions"][number];

/**
 * Every captured action behind the draft, in the order it was demonstrated.
 * Corrections move Step boundaries across this one sequence, so the actions a
 * Step covers follow from the span it names — never from where the Step sits
 * in a list the user has since merged or split.
 */
export const demonstratedActions = (
  evidence: readonly AgentFlowEvidenceSummary[]
): readonly DemonstratedAction[] =>
  evidence
    .toSorted((one, other) => one.stepIndex - other.stepIndex)
    .flatMap((summary) => summary.actions);

/** The captured actions one edited Step covers, in the order they happened. */
export const spanActions = (
  actions: readonly DemonstratedAction[],
  step: DraftStepEdit
): readonly DemonstratedAction[] => {
  const from = actions.findIndex(({ id }) => id === step.firstActionId);
  const to = actions.findIndex(({ id }) => id === step.lastActionId);
  if (from === -1 || to < from) {
    return [];
  }
  return actions.slice(from, to + 1);
};

/**
 * The compiled Evidence Slice for exactly this span, when one exists. A merged
 * or split Step has no slice until the correction is saved, because
 * Contingency derives every slice from the span the saved proposal names.
 */
export const spanEvidence = (
  evidence: readonly AgentFlowEvidenceSummary[],
  step: DraftStepEdit
): AgentFlowEvidenceSummary | undefined =>
  evidence.find(
    (summary) =>
      summary.actions[0]?.id === step.firstActionId &&
      summary.actions.at(-1)?.id === step.lastActionId
  );

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
  edited,
  revisionId,
  revisionStatus,
  verification,
}: {
  readonly edited: boolean;
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
  if (edited) {
    return {
      action: undefined,
      canApprove: false,
      detail:
        "Save your corrections first. Every changed draft needs its own verification authorization.",
      status: "none",
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
 * One slot per draft revision, so two reviews on screen never share state —
 * and the slot outlives the review, so a region that momentarily leaves the
 * screen comes back to what the user typed rather than to the manifest.
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

/**
 * The user's unsaved corrections, or `undefined` while the draft still reads
 * as the agent proposed it. Holding them apart from the revision is what lets
 * a reread update what the draft is verified as without touching what the
 * user has typed.
 */
export interface DraftCorrections {
  readonly edit: DraftReviewEdit;
  /**
   * The Domain Scope textarea as typed. Parsing on every keystroke would eat a
   * fresh line before the user names the host that follows it.
   */
  readonly hostsText: string;
}

export const draftCorrectionsAtom = perRevision<DraftCorrections | null>(null);

/**
 * The gesture this review last asked for. Its own RPC result — and no other
 * gesture's — is what the review reports as pending or refused.
 */
export type DraftGesture = "approve" | "archive" | "authorize" | "update";

export const draftGestureAtom = perRevision<DraftGesture | null>(null);

/** The action each Step's split control is aimed at, by Step index. */
const splitFamily = retainedFamily<string>("");

export const draftSplitAtom =
  (key: DraftReviewKey) =>
  (index: number): Atom.Writable<string, string> =>
    splitFamily(`${key.agentFlowId}\u0000${key.revisionId}\u0000${index}`);

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
