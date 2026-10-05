import { OperationId } from "@contingency/protocol";
import type {
  AgentPendingDecision,
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import {
  AnsweredVariable,
  RequestHeader,
  VariableField,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { Badge } from "@/components/ui/badge";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const PrerequisiteVariable = ({
  sessionId,
  decision,
}: {
  readonly sessionId: AgentSessionId;
  readonly decision: AgentPendingDecision;
}) => {
  const { agentDryRunVariableAnswerMutation } = useRpcDependencies();
  const answer = useAtomSet(agentDryRunVariableAnswerMutation, {
    mode: "promise",
  });
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  const label = `${decision.variable?.flowSkillName}/${decision.variable?.name}`;
  const submit = async (value: string | null) => {
    setState((current) => ({ ...current, error: "", pending: true }));
    try {
      await answer({
        payload: {
          decision: value === null ? "refuse" : "supply",
          operationId: OperationId.make(crypto.randomUUID()),
          pendingDecisionId: decision.pendingDecisionId,
          sessionId,
          value: value ?? undefined,
        },
      });
      setState({ error: "", pending: false, value: "" });
    } catch (error) {
      setState({
        error: failureMessage(error, "Could not answer the input request."),
        pending: false,
        value: "",
      });
    }
  };
  return (
    <VariableField
      error={state.error === "" ? undefined : state.error}
      id={decision.pendingDecisionId}
      label={label}
      onRefuse={async () => {
        await submit(null);
      }}
      onSubmit={async () => {
        await submit(state.value);
      }}
      onValueChange={(value) => setState((current) => ({ ...current, value }))}
      pending={state.pending}
      purpose={decision.scopeSummary}
      refuseLabel={`Refuse ${label}`}
      supplyLabel={`Supply ${label}`}
      value={state.value}
    />
  );
};

/**
 * Private inputs the user supplies or refuses in Workspace. The agent sees
 * each one's status, never its value. A Dry Run takes its prerequisite
 * Variables here, and an Example Run takes its bundled skill's private inputs.
 */
export const WorkspaceVariables = ({
  collapse,
  description,
  heading,
  session,
}: {
  /** The tier's collapse control, when this is its first request. */
  readonly collapse?: React.ReactNode;
  readonly description: string;
  readonly heading: string;
  readonly session: AgentSessionSnapshot;
}) => {
  const pending = session.pendingDecisions.filter(
    (decision) => decision.kind === "supply_variable"
  );
  const pendingScopes = new Set(
    pending.map((decision) =>
      JSON.stringify([
        decision.variable?.flowSkillName,
        decision.variable?.name,
      ])
    )
  );
  const answers =
    session.run !== null && "schemaVersion" in session.run
      ? session.run.variables.filter(
          (variable) =>
            variable.lastAnswer !== undefined &&
            !pendingScopes.has(
              JSON.stringify([variable.flowSkillName, variable.name])
            )
        )
      : [];
  if (pending.length === 0 && answers.length === 0) {
    return null;
  }
  return (
    <section aria-label={heading} className="space-y-2">
      <RequestHeader
        action={collapse}
        badge={
          pending.length === 0 ? null : (
            <Badge variant="secondary">{pending.length} needed</Badge>
          )
        }
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title={heading}
      />
      <p className="text-muted-foreground text-xs text-pretty">{description}</p>
      <div className="space-y-2.5">
        {pending.map((decision) => (
          <PrerequisiteVariable
            key={decision.pendingDecisionId}
            sessionId={session.id}
            decision={decision}
          />
        ))}
      </div>
      {answers.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {answers.map((answer) => (
            <AnsweredVariable
              key={JSON.stringify([answer.flowSkillName, answer.name])}
              label={`${answer.flowSkillName}/${answer.name}`}
              status={answer.lastAnswer ?? ""}
            />
          ))}
        </div>
      )}
    </section>
  );
};

export const DryRunPrerequisiteVariables = ({
  collapse,
  session,
}: {
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => (
  <WorkspaceVariables
    collapse={collapse}
    description="Supply or refuse private prerequisite inputs here. The agent sees their status, never their values."
    heading="Prerequisite Variables"
    session={session}
  />
);

export const ExampleVariables = ({
  collapse,
  session,
}: {
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => (
  <WorkspaceVariables
    collapse={collapse}
    description="Supply or refuse this Example's private inputs here. The demo account accepts any password of at least 8 characters. The agent sees their status, never their values."
    heading="Example private inputs"
    session={session}
  />
);
