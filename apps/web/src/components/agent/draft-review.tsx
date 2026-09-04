import type {
  AgentFlowEvidenceSummary,
  AgentFlowId,
  AgentFlowRevisionId,
  AgentSessionId,
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
  draftCorrectionsAtom,
  draftEditFromManifest,
  draftGestureAtom,
  draftIsEdited,
  draftProposalFrom,
  draftSplitAtom,
  draftVariableDraftAtom,
  editHosts,
  editStep,
  mergeStepWithNext,
  parseHosts,
  refusal,
  shownRevision,
  splitStepAt,
  stepActionIds,
} from "@/components/agent/draft-review-state";
import type {
  DraftReviewEdit,
  DraftReviewKey,
} from "@/components/agent/draft-review-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  agentFlowApproveMutation,
  agentFlowDraftUpdateMutation,
  agentFlowRevisionAtom,
  agentFlowVerificationAuthorizeMutation,
  agentVariableSupplyMutation,
} from "@/lib/rpc";

const operationId = () => OperationId.make(crypto.randomUUID());

const StepEditor = ({
  actionIds,
  canEdit,
  evidence,
  index,
  isLast,
  onChange,
  onMerge,
  onSplit,
  reviewKey,
  step,
}: {
  readonly actionIds: readonly string[];
  readonly canEdit: boolean;
  readonly evidence: AgentFlowEvidenceSummary | undefined;
  readonly index: number;
  readonly isLast: boolean;
  readonly onChange: (patch: {
    readonly confirmation?: boolean;
    readonly description?: string;
    readonly name?: string;
  }) => void;
  readonly onMerge: () => void;
  readonly onSplit: (actionId: string) => void;
  readonly reviewKey: DraftReviewKey;
  readonly step: DraftReviewEdit["steps"][number];
}) => {
  const [splitAt, setSplitAt] = useAtom(draftSplitAtom(reviewKey)(index));
  // A Step always covers at least one action, so its first action can never
  // start the second half of a split.
  const splitPoints = actionIds.slice(1);
  return (
    <li className="space-y-3 p-3">
      <div className="space-y-2">
        <Label htmlFor={`agent-step-name-${index}`}>
          Agent Step {index + 1} name
        </Label>
        <Input
          disabled={!canEdit}
          id={`agent-step-name-${index}`}
          onChange={(event) => onChange({ name: event.target.value })}
          value={step.name}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`agent-step-description-${index}`}>
          Agent Step {index + 1} description
        </Label>
        <Textarea
          disabled={!canEdit}
          id={`agent-step-description-${index}`}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={2}
          value={step.description}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={step.confirmation}
          disabled={!canEdit}
          id={`agent-step-confirmation-${index}`}
          onCheckedChange={(checked) =>
            onChange({ confirmation: checked === true })
          }
        />
        <Label htmlFor={`agent-step-confirmation-${index}`}>
          {`Agent Step ${index + 1} Confirmation Step: ask me before each irreversible attempt`}
        </Label>
      </div>
      {evidence === undefined ? null : (
        <div className="text-muted-foreground space-y-1 text-xs">
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
          <ul aria-label={`Agent Step ${index + 1} evidence`}>
            {evidence.actions.map((action) => (
              <li key={action.id}>
                {action.actor === "user" ? "You" : "The agent"}:{" "}
                {action.description} · {action.outcome}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2">
          {isLast ? null : (
            <Button onClick={onMerge} size="sm" type="button" variant="outline">
              Merge with next Step
            </Button>
          )}
          {splitPoints.length === 0 ? null : (
            <>
              <div className="space-y-1">
                <Label htmlFor={`agent-step-split-${index}`}>
                  Split Agent Step {index + 1} before
                </Label>
                <NativeSelect
                  id={`agent-step-split-${index}`}
                  onChange={(event) => setSplitAt(event.target.value)}
                  value={splitAt}
                >
                  <NativeSelectOption value="">
                    Choose an action
                  </NativeSelectOption>
                  {splitPoints.map((actionId) => (
                    <NativeSelectOption key={actionId} value={actionId}>
                      {evidence?.actions.find(({ id }) => id === actionId)
                        ?.description ?? actionId}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <Button
                disabled={splitAt === ""}
                onClick={() => onSplit(splitAt)}
                size="sm"
                type="button"
                variant="outline"
              >
                Split Step
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
};

const VariableSupply = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
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
  const { verification } = session;
  if (verification === null) {
    return null;
  }
  const runtime = verification.variables.filter((variable) => variable.runtime);
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
        Verification never reuses what Teaching prepared, so this Run asks for
        these values again. They stay on this machine and never reach the agent.
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

/**
 * The draft under review. The user reads what verification would authorize,
 * corrects the agent's proposed objectives and Domain Scope, and performs the
 * two gestures no MCP tool can reach: authorizing one Verification Run of one
 * exact revision, and approving the revision that Run proved
 * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const DraftReview = ({
  agentFlowId,
  refreshToken,
  revisionId,
  sessionId,
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
  /** The Teaching session whose Demonstration corrections compile against. */
  readonly sessionId: AgentSessionId | undefined;
}) => {
  const reviewKey: DraftReviewKey = { agentFlowId, revisionId };
  const revisionAtom = agentFlowRevisionAtom(agentFlowId, revisionId);
  const revisionResult = useAtomValue(revisionAtom);
  const rereadRevision = useAtomRefresh(revisionAtom);
  const [updateResult, updateDraft] = useAtom(agentFlowDraftUpdateMutation);
  const [authorizeResult, authorize] = useAtom(
    agentFlowVerificationAuthorizeMutation
  );
  const [approveResult, approve] = useAtom(agentFlowApproveMutation);
  const [gesture, setGesture] = useAtom(draftGestureAtom(reviewKey));
  const [corrections, setCorrections] = useAtom(
    draftCorrectionsAtom(reviewKey)
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

  const gestureResult = (() => {
    if (gesture === "approve") {
      return approveResult;
    }
    if (gesture === "authorize") {
      return authorizeResult;
    }
    return gesture === "update" ? updateResult : undefined;
  })();
  const detail = shownRevision(revisionResult, gestureResult);
  const pending =
    gestureResult !== undefined && AsyncResult.isWaiting(gestureResult);
  const failure = refusal(gestureResult);

  if (detail === undefined) {
    return (
      <section aria-labelledby="agent-draft" className="space-y-2">
        <h2 className="text-sm font-semibold" id="agent-draft">
          Draft review
        </h2>
        <p className="text-muted-foreground text-xs">
          {refusal(revisionResult) ?? "Loading the draft Agent Flow."}
        </p>
      </section>
    );
  }

  const { manifest } = detail.revision;
  /**
   * Unsaved corrections outrank a reread: a refresh that arrives while the
   * user is still editing updates what the draft is verified as, never what
   * the user has typed.
   */
  const edit =
    corrections === null ? draftEditFromManifest(manifest) : corrections.edit;
  const hostsText =
    corrections === null
      ? manifest.domainScope.hosts.join("\n")
      : corrections.hostsText;
  const correct = (change: (current: DraftReviewEdit) => DraftReviewEdit) => {
    setCorrections({ edit: change(edit), hostsText });
  };
  const edited = draftIsEdited(manifest, edit);
  const canEdit = sessionId !== undefined && manifest.status === "draft";
  const authorization = authorizationPresentation(
    detail.revision.heads.verification,
    manifest.revisionId,
    edited
  );

  const saveCorrections = () => {
    if (sessionId === undefined) {
      return;
    }
    setGesture("update");
    updateDraft({
      payload: {
        data: {
          agentFlowId: manifest.agentFlowId,
          basedOnRevisionId: manifest.revisionId,
          draft: draftProposalFrom(manifest, edit),
          operationId: operationId(),
          sessionId,
        },
        type: "agent.flow.draft.update",
      },
    });
  };

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
          {edit.steps.map((step, index) => (
            <StepEditor
              actionIds={stepActionIds(detail.evidence, index)}
              canEdit={canEdit}
              evidence={detail.evidence[index]}
              index={index}
              isLast={index === edit.steps.length - 1}
              // Steps are reordered by merging and splitting, so the demonstrated
              // span they cover is what identifies one across an edit.
              key={`${step.firstActionId}-${step.lastActionId}`}
              onChange={(patch) =>
                correct((current) => editStep(current, index, patch))
              }
              onMerge={() =>
                correct((current) => mergeStepWithNext(current, index))
              }
              onSplit={(actionId) =>
                correct((current) =>
                  splitStepAt(
                    current,
                    index,
                    stepActionIds(detail.evidence, index),
                    actionId
                  )
                )
              }
              reviewKey={reviewKey}
              step={step}
            />
          ))}
        </ul>

        <div className="space-y-2">
          <Label htmlFor="agent-domain-scope">Domain Scope</Label>
          <p className="text-muted-foreground text-xs">
            One exact host or explicit <code>*.example.com</code> pattern per
            line. The agent may not visit anything else.
          </p>
          <Textarea
            disabled={!canEdit}
            id="agent-domain-scope"
            onChange={(event) => {
              const text = event.target.value;
              setCorrections({
                edit: editHosts(edit, parseHosts(text)),
                hostsText: text,
              });
            }}
            rows={3}
            value={hostsText}
          />
        </div>

        <div className="space-y-1">
          <h3 className="text-xs font-semibold">Variables</h3>
          {manifest.variables.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              This journey declares no Variables.
            </p>
          ) : (
            <ul
              aria-label="Variables"
              className="text-muted-foreground text-xs"
            >
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

        {canEdit ? (
          <Button
            disabled={pending || !edited}
            onClick={saveCorrections}
            size="sm"
            type="button"
          >
            Save corrections
          </Button>
        ) : null}

        <div className="space-y-2 border-t pt-3">
          <h3 className="text-xs font-semibold">Verification</h3>
          <p className="text-muted-foreground text-xs">
            {authorization.detail}
          </p>
          {authorization.action === undefined ? null : (
            <Button
              disabled={pending}
              onClick={() => {
                setGesture("authorize");
                authorize({
                  payload: {
                    data: {
                      agentFlowId: manifest.agentFlowId,
                      operationId: operationId(),
                      revisionId: manifest.revisionId,
                    },
                    type: "agent.flow.verification.authorize",
                  },
                });
              }}
              size="sm"
              type="button"
            >
              {authorization.action}
            </Button>
          )}
          {authorization.canApprove ? (
            <Alert>
              <CircleCheckIcon aria-hidden="true" />
              <AlertTitle>This draft passed verification</AlertTitle>
              <AlertDescription>
                <span>
                  Approving makes this exact revision the Approved Agent Flow.
                  It cannot be edited afterwards; a change creates a new draft.
                </span>
                <Button
                  disabled={pending}
                  onClick={() => {
                    setGesture("approve");
                    approve({
                      payload: {
                        data: {
                          agentFlowId: manifest.agentFlowId,
                          operationId: operationId(),
                          revisionId: manifest.revisionId,
                        },
                        type: "agent.flow.approve",
                      },
                    });
                  }}
                  size="sm"
                  type="button"
                >
                  Approve Agent Flow
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {failure === undefined ? null : (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>That action was refused</AlertTitle>
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </section>
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
        sessionId={undefined}
      />
    </>
  );
};
