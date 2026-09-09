import type {
  AgentFlowEvidenceSummary,
  AgentFlowHeads,
  AgentFlowId,
  AgentFlowManifest,
  AgentFlowRevisionId,
  AgentFlowVerification,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { OperationId } from "@contingency/protocol";
import {
  useAtom,
  useAtomRefresh,
  useAtomSubscribe,
  useAtomValue,
} from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { CircleAlertIcon, CircleCheckIcon, KeyRoundIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef } from "react";

import {
  authorizationPresentation,
  draftDeletionConfirmationAtom,
  draftVariableDraftAtom,
  refusal,
  shownRevision,
} from "@/components/agent/draft-review-state";
import type {
  AuthorizationPresentation,
  DraftRevisionDetail,
} from "@/components/agent/draft-review-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const operationId = () => OperationId.make(crypto.randomUUID());

const headsForMutation = (heads: AgentFlowHeads) => ({
  approvedRevisionId: heads.approvedRevisionId,
  archived: heads.archived,
  draftRevisionId: heads.draftRevisionId,
});

type DemonstratedAction = AgentFlowEvidenceSummary["actions"][number];

/**
 * What one Step was demonstrated by. A merged or split span has no compiled
 * Evidence Slice yet, because Contingency derives every slice from the span
 * the saved proposal names
 * ([ADR 0025](../../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 */
const StepEvidence = ({
  actions,
  evidence,
  index,
}: {
  readonly actions: readonly DemonstratedAction[];
  readonly evidence: AgentFlowEvidenceSummary | undefined;
  readonly index: number;
}) => {
  if (actions.length === 0) {
    return null;
  }
  const plural = actions.length === 1 ? "" : "s";
  return (
    <div className="text-muted-foreground space-y-1 text-xs">
      {evidence === undefined ? (
        <p>
          {actions.length} captured action{plural}. Contingency derives this
          Step's Evidence Slice from the span when you save the correction.
        </p>
      ) : (
        <>
          <p>
            Evidence: {evidence.actions.length} captured action
            {evidence.actions.length === 1 ? "" : "s"},{" "}
            {evidence.instructions.length} instruction
            {evidence.instructions.length === 1 ? "" : "s"},{" "}
            {evidence.screenshotCount} screenshot
            {evidence.screenshotCount === 1 ? "" : "s"},{" "}
            {evidence.urlTransitionCount} URL transition
            {evidence.urlTransitionCount === 1 ? "" : "s"}.
          </p>
          <p className="font-mono wrap-anywhere">{evidence.hash}</p>
        </>
      )}
      <ul aria-label={`Agent Step ${index + 1} evidence`}>
        {actions.map((action) => (
          <li key={action.id}>
            {action.actor === "user" ? "You" : "The agent"}:{" "}
            {action.description} · {action.outcome}
          </li>
        ))}
      </ul>
    </div>
  );
};

const StepReview = ({
  evidence,
  index,
  step,
}: {
  readonly evidence: AgentFlowEvidenceSummary | undefined;
  readonly index: number;
  readonly step: AgentFlowManifest["steps"][number];
}) => (
  <li className="space-y-3 p-3">
    <div className="space-y-1">
      <h3 className="text-xs font-semibold">
        Agent Step {index + 1}: {step.name}
      </h3>
      <p className="text-muted-foreground text-xs">{step.description}</p>
      <p className="text-muted-foreground text-xs">
        {step.confirmation
          ? "Confirmation Step: asks before each irreversible attempt."
          : "No confirmation required."}
      </p>
    </div>
    <StepEvidence
      actions={evidence?.actions ?? []}
      evidence={evidence}
      index={index}
    />
  </li>
);

/**
 * Runtime Variables the live Run still needs. A Verification Run and an
 * Interactive Run ask the same way and for the same reason: the literal is
 * supplied again by the user and never reaches the agent or the artifacts.
 */
export const VariableSupply = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { agentVariableSupplyMutation } = useRpcDependencies();
  const [supplyResult, supply] = useAtom(agentVariableSupplyMutation);
  const [values, setValues] = useAtom(draftVariableDraftAtom(session.id));
  /** Which Variable the Run is being told, so its field clears once it lands. */
  const supplying = useRef<string | null>(null);
  useAtomSubscribe(agentVariableSupplyMutation, (result) => {
    const name = supplying.current;
    if (name === null || !AsyncResult.isSuccess(result)) {
      return;
    }
    supplying.current = null;
    setValues((current) => ({ ...current, [name]: "" }));
  });
  const failure = refusal(supplyResult);
  const declaring = session.verification ?? session.run;
  if (declaring === null) {
    return null;
  }
  const runtime = declaring.variables.filter((variable) => variable.runtime);
  if (runtime.length === 0) {
    return null;
  }
  const submit = (name: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    supplying.current = name;
    supply({
      payload: {
        data: {
          name,
          operationId: operationId(),
          sessionId: session.id,
          value: values[name] ?? "",
        },
        type: "agent.session.variable.supply",
      },
    });
  };
  return (
    <section
      aria-labelledby="agent-verification-variables"
      className="space-y-2"
    >
      <h2 className="text-sm font-semibold" id="agent-verification-variables">
        Runtime Variables
      </h2>
      <p className="text-muted-foreground text-xs">
        A Run never reuses what Teaching prepared, so it asks for these values
        again. They stay on this machine and never reach the agent.
      </p>
      <div className="space-y-3 rounded-lg border p-3">
        {runtime.map((variable) => (
          <form key={variable.name} onSubmit={submit(variable.name)}>
            <div className="space-y-2">
              <Label htmlFor={`agent-variable-${variable.name}`}>
                {variable.name}
                {variable.supplied ? " · supplied" : ""}
              </Label>
              <Input
                autoComplete="off"
                id={`agent-variable-${variable.name}`}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [variable.name]: event.target.value,
                  }))
                }
                type={variable.secret ? "password" : "text"}
                value={values[variable.name] ?? ""}
              />
              <Button size="sm" type="submit" variant="outline">
                <KeyRoundIcon aria-hidden="true" />
                Supply {variable.name}
              </Button>
            </div>
          </form>
        ))}
        {failure === undefined ? null : (
          <p className="text-destructive text-xs">{failure}</p>
        )}
      </div>
    </section>
  );
};

/** What the draft declares beyond its Steps: its Variables and its Emulation. */
const DraftFacts = ({ manifest }: { readonly manifest: AgentFlowManifest }) => (
  <>
    <div className="space-y-1">
      <h3 className="text-xs font-semibold">Variables</h3>
      {manifest.variables.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          This journey declares no Variables.
        </p>
      ) : (
        <ul aria-label="Variables" className="text-muted-foreground text-xs">
          {manifest.variables.map((variable) => (
            <li key={variable.name}>
              {variable.name}
              {variable.secret ? " · secret" : ""}
              {variable.runtime ? " · asked for at run time" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>

    <div className="space-y-1">
      <h3 className="text-xs font-semibold">Emulation</h3>
      <p className="text-muted-foreground text-xs">
        {manifest.emulation.userAgentProfile} ·{" "}
        {manifest.emulation.viewport.width} ×{" "}
        {manifest.emulation.viewport.height}
      </p>
    </div>
  </>
);

const VerificationGestures = ({
  authorization,
  heads,
  manifest,
  verification,
}: {
  readonly authorization: AuthorizationPresentation;
  readonly heads: AgentFlowHeads;
  readonly manifest: AgentFlowManifest;
  readonly verification: AgentFlowVerification | null;
}) => {
  const pendingDecisions = heads.pendingDecisions ?? [];
  const approvalPending = pendingDecisions.some(
    (decision) => decision.kind === "approve_flow"
  );
  return (
    <div className="space-y-2 border-t pt-3">
      <h3 className="text-xs font-semibold">Verification</h3>
      <p className="text-muted-foreground text-xs">{authorization.detail}</p>
      {verification === null || verification.assessments.length === 0 ? null : (
        <ol aria-label="Verification Step verdicts" className="space-y-2">
          {verification.assessments.map((assessment) => {
            const step = manifest.steps[assessment.stepIndex];
            return (
              <li
                className="space-y-1 rounded-md border p-2"
                key={assessment.stepIndex}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    Step {assessment.stepIndex + 1}:{" "}
                    {step?.name ?? "Unknown Step"}
                  </span>
                  <Badge
                    variant={
                      assessment.outcome === "working"
                        ? "default"
                        : "destructive"
                    }
                  >
                    {assessment.outcome}
                  </Badge>
                </div>
                <p className="text-muted-foreground text-xs">
                  {assessment.explanation}
                </p>
                <p className="text-muted-foreground font-mono text-xs wrap-anywhere">
                  Evidence:{" "}
                  {assessment.evidence
                    .map((reference) => `${reference.kind} ${reference.id}`)
                    .join(", ")}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {pendingDecisions.map((decision) => (
        <Alert key={decision.pendingDecisionId}>
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>
            Pending in the agent conversation:{" "}
            <span>
              {decision.kind === "authorize_verification"
                ? "verification authorization"
                : "flow approval"}
            </span>
          </AlertTitle>
          <AlertDescription>
            <span>{decision.scopeSummary}</span>
            <code className="block wrap-anywhere">
              {decision.pendingDecisionId}
            </code>
          </AlertDescription>
        </Alert>
      ))}
      {authorization.canApprove && approvalPending ? (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertTitle>This draft passed verification</AlertTitle>
          <AlertDescription>
            Approve or refuse the pending decision in your agent conversation.
          </AlertDescription>
        </Alert>
      ) : null}
      {(heads.decisionHistory ?? []).map((resolution) =>
        resolution.revisionId === manifest.revisionId ? (
          <p
            className="text-muted-foreground text-xs"
            key={resolution.operationId}
          >
            {resolution.kind} {resolution.decision} at {resolution.decidedAt}
          </p>
        ) : null
      )}
    </div>
  );
};

const RetirementControls = ({
  archiveFailure,
  archived,
  confirmation,
  deleteFailure,
  deleted,
  onArchive,
  onConfirmationChange,
  onDelete,
  pending,
}: {
  readonly archiveFailure: string | undefined;
  readonly archived: boolean;
  readonly confirmation: string;
  readonly deleteFailure: string | undefined;
  readonly deleted: boolean;
  readonly onArchive: () => void;
  readonly onConfirmationChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly pending: boolean;
}) => (
  <div className="space-y-3 border-t pt-3">
    <h3 className="text-xs font-semibold">Retire Agent Flow</h3>
    <p className="text-muted-foreground text-xs">
      Archive hides this Agent Flow from normal search without removing its
      revisions. Permanent deletion cannot be undone.
    </p>
    <Button
      disabled={pending || deleted}
      onClick={onArchive}
      size="sm"
      type="button"
      variant="outline"
    >
      {archived ? "Restore Agent Flow" : "Archive Agent Flow"}
    </Button>
    <div className="space-y-2">
      <Label htmlFor="agent-flow-delete-confirmation">
        Type permanently-delete to confirm permanent deletion
      </Label>
      <Input
        autoComplete="off"
        disabled={pending || deleted}
        id="agent-flow-delete-confirmation"
        onChange={(event) => onConfirmationChange(event.target.value)}
        value={confirmation}
      />
      <Button
        disabled={pending || deleted || confirmation !== "permanently-delete"}
        onClick={onDelete}
        size="sm"
        type="button"
        variant="destructive"
      >
        Permanently delete Agent Flow
      </Button>
    </div>
    {deleted ? (
      <p className="text-muted-foreground text-xs">
        This Agent Flow was permanently deleted.
      </p>
    ) : null}
    {archiveFailure === undefined ? null : (
      <p className="text-destructive text-xs">{archiveFailure}</p>
    )}
    {deleteFailure === undefined ? null : (
      <p className="text-destructive text-xs">{deleteFailure}</p>
    )}
  </div>
);

const DraftReviewLoading = ({ message }: { readonly message: string }) => (
  <section aria-labelledby="agent-draft" className="space-y-2">
    <h2 className="text-sm font-semibold" id="agent-draft">
      Draft review
    </h2>
    <p className="text-muted-foreground text-xs">{message}</p>
  </section>
);

const DraftReviewContent = ({
  archiveFailure,
  authorization,
  confirmation,
  deleteFailure,
  deleted,
  detail,
  onArchive,
  onConfirmationChange,
  onDelete,
  retirementPending,
}: {
  readonly archiveFailure: string | undefined;
  readonly authorization: AuthorizationPresentation;
  readonly confirmation: string;
  readonly deleteFailure: string | undefined;
  readonly deleted: boolean;
  readonly detail: DraftRevisionDetail;
  readonly onArchive: () => void;
  readonly onConfirmationChange: (value: string) => void;
  readonly onDelete: () => void;
  readonly retirementPending: boolean;
}) => {
  const { manifest } = detail.revision;
  return (
    <section aria-labelledby="agent-draft" className="space-y-3">
      <h2 className="text-sm font-semibold" id="agent-draft">
        Draft review
      </h2>
      <div className="space-y-4 rounded-lg border p-3 text-sm">
        <div className="space-y-1">
          <p className="font-medium">{manifest.title}</p>
          <p className="text-muted-foreground text-xs">
            {manifest.description}
          </p>
          <p className="font-mono text-xs wrap-anywhere">
            {manifest.agentFlowId} / {manifest.revisionId}
          </p>
          <Badge
            variant={manifest.status === "approved" ? "default" : "secondary"}
          >
            {manifest.status === "approved"
              ? "Approved Agent Flow"
              : "Draft revision"}
          </Badge>
        </div>

        <ul aria-label="Agent Steps" className="divide-y rounded-lg border">
          {manifest.steps.map((step, index) => (
            <StepReview
              evidence={detail.evidence.find(
                (summary) => summary.stepIndex === index
              )}
              index={index}
              key={step.index}
              step={step}
            />
          ))}
        </ul>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold">Domain Scope</h3>
          <p className="text-muted-foreground text-xs">
            The agent may visit only these exact hosts or explicit wildcard
            patterns.
          </p>
          <ul aria-label="Domain Scope" className="font-mono text-xs">
            {manifest.domainScope.hosts.map((host) => (
              <li key={host}>{host}</li>
            ))}
          </ul>
        </div>

        <DraftFacts manifest={manifest} />

        <p className="text-muted-foreground text-xs">
          To correct this draft, describe the change in your agent conversation
          and confirm when it should be saved.
        </p>

        <VerificationGestures
          authorization={authorization}
          heads={detail.revision.heads}
          manifest={manifest}
          verification={detail.revision.heads.verification}
        />
        <RetirementControls
          archiveFailure={archiveFailure}
          archived={detail.revision.heads.archived}
          confirmation={confirmation}
          deleteFailure={deleteFailure}
          deleted={deleted}
          onArchive={onArchive}
          onConfirmationChange={onConfirmationChange}
          onDelete={onDelete}
          pending={retirementPending}
        />
      </div>
    </section>
  );
};

/**
 * The draft under review. The user reads what verification would authorize,
 * corrects the agent's proposed objectives and Domain Scope, and mirrors
 * verification decisions relayed through the agent conversation.
 */
export const DraftReview = ({
  agentFlowId,
  refreshToken,
  revisionId,
}: {
  readonly agentFlowId: AgentFlowId;
  /**
   * Any value that changes when the session moved. The Verification Run's
   * outcome is written by the agent, so Agent View only learns that a draft
   * passed — and may therefore be approved — by rereading the revision when
   * the session it belongs to changes.
   */
  readonly refreshToken: string;
  readonly revisionId: AgentFlowRevisionId;
}) => {
  const {
    agentFlowArchiveMutation,
    agentFlowDeleteMutation,
    agentFlowRevisionAtom,
  } = useRpcDependencies();
  const revisionAtom = agentFlowRevisionAtom(agentFlowId, revisionId);
  const revisionResult = useAtomValue(revisionAtom);
  const rereadRevision = useAtomRefresh(revisionAtom);
  const [archiveResult, archive] = useAtom(agentFlowArchiveMutation);
  const [deleteResult, deleteAgentFlow] = useAtom(agentFlowDeleteMutation);
  const [deleteConfirmation, setDeleteConfirmation] = useAtom(
    draftDeletionConfirmationAtom({ agentFlowId, revisionId })
  );

  /**
   * The session moving is the only signal that the revision may read
   * differently now, because the agent — not Agent View — writes a
   * Verification Run's outcome.
   */
  const rereadAt = useRef(refreshToken);
  useEffect(() => {
    if (rereadAt.current === refreshToken) {
      return;
    }
    rereadAt.current = refreshToken;
    rereadRevision();
  }, [refreshToken, rereadRevision]);

  const detail = shownRevision(revisionResult, archiveResult);
  const archiveFailure = refusal(archiveResult);
  const deleteFailure = refusal(deleteResult);
  const deleted =
    AsyncResult.isSuccess(deleteResult) &&
    deleteResult.value.data.agentFlowId === agentFlowId;

  if (detail === undefined) {
    return (
      <DraftReviewLoading
        message={refusal(revisionResult) ?? "Loading the draft Agent Flow."}
      />
    );
  }

  const { manifest } = detail.revision;
  const authorization = authorizationPresentation({
    revisionId: manifest.revisionId,
    revisionStatus: manifest.status,
    verification: detail.revision.heads.verification,
  });

  const setArchiveState = () => {
    archive({
      payload: {
        data: {
          agentFlowId: manifest.agentFlowId,
          archived: !detail.revision.heads.archived,
          expectedHeads: headsForMutation(detail.revision.heads),
          operationId: operationId(),
        },
        type: "agent.flow.archive",
      },
    });
  };

  const permanentlyDelete = () => {
    if (deleteConfirmation !== "permanently-delete") {
      return;
    }
    deleteAgentFlow({
      payload: {
        data: {
          agentFlowId: manifest.agentFlowId,
          confirmation: deleteConfirmation,
          expectedHeads: headsForMutation(detail.revision.heads),
          operationId: operationId(),
        },
        type: "agent.flow.delete",
      },
    });
  };

  return (
    <DraftReviewContent
      archiveFailure={archiveFailure}
      authorization={authorization}
      confirmation={deleteConfirmation}
      deleteFailure={deleteFailure}
      deleted={deleted}
      detail={detail}
      onArchive={setArchiveState}
      onConfirmationChange={setDeleteConfirmation}
      onDelete={permanentlyDelete}
      retirementPending={
        AsyncResult.isWaiting(deleteResult) ||
        AsyncResult.isWaiting(archiveResult)
      }
    />
  );
};

/** What a Verification Run shows: its draft, its Variables, and its outcome. */
export const VerificationDetails = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { verification } = session;
  if (verification === null) {
    return null;
  }
  return (
    <>
      <section aria-labelledby="agent-verification" className="space-y-2">
        <h2 className="text-sm font-semibold" id="agent-verification">
          Verification Run
        </h2>
        <div className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">{verification.title}</p>
          <p className="text-muted-foreground text-xs">
            A fresh browser context, opened for this exact draft revision. It
            inherits nothing the Teaching session prepared.
          </p>
          <p className="font-mono text-xs wrap-anywhere">
            {verification.revisionId}
          </p>
          {verification.outcome === null ? null : (
            <Badge
              variant={
                verification.outcome === "passed" ? "default" : "destructive"
              }
            >
              Verification {verification.outcome}
            </Badge>
          )}
        </div>
      </section>
      <VariableSupply session={session} />
      <DraftReview
        agentFlowId={verification.agentFlowId}
        refreshToken={session.updatedAt}
        revisionId={verification.revisionId}
      />
    </>
  );
};
