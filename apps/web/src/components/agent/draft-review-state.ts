import type {
  AgentFlowDraftProposal,
  AgentFlowEvidenceSummary,
  AgentFlowManifest,
  AgentFlowVerification,
  AgentFlowVerificationStatus,
} from "@contingency/protocol";

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

/** The captured action ids one Step covers, in the order they happened. */
export const stepActionIds = (
  evidence: readonly AgentFlowEvidenceSummary[],
  index: number
): readonly string[] =>
  evidence
    .find((summary) => summary.stepIndex === index)
    ?.actions.map((action) => action.id) ?? [];

export interface AuthorizationPresentation {
  /** What the one verification button does next, or nothing when it is hidden. */
  readonly action: string | undefined;
  /** Whether Agent View offers the separate approval action. */
  readonly canApprove: boolean;
  readonly detail: string;
  readonly status: AgentFlowVerificationStatus | "none";
}

/**
 * How Agent View describes the verification of one exact draft revision. An
 * authorization for another revision is not this draft's authorization, so a
 * corrected draft always reads as unauthorized.
 */
export const authorizationPresentation = (
  verification: AgentFlowVerification | null,
  revisionId: string,
  edited: boolean
): AuthorizationPresentation => {
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
      action: "Authorize Verification Run",
      canApprove: false,
      detail:
        "Verification opens a fresh browser and asks for this Agent Flow's runtime Variables again. One authorization funds one Run of this exact draft.",
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
    action: "Authorize Verification Run",
    canApprove: false,
    detail: `Verification failed: ${verification.summary ?? "the agent reported no explanation."} Any existing Approved Agent Flow is unchanged.`,
    status: "failed",
  };
};
