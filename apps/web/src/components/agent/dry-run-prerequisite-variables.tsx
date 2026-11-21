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
  AnsweredVariables,
  RequestHeader,
  RequestNote,
  VariableField,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import {
  runtimeVariables,
  stillNeeded,
} from "@/components/agent/dock-requests-state";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const PrerequisiteVariable = ({
  decision,
  masked,
  sessionId,
}: {
  readonly decision: AgentPendingDecision;
  readonly masked: boolean;
  readonly sessionId: AgentSessionId;
}) => {
  const { agentDryRunVariableAnswerMutation } = useRpcDependencies();
  const answer = useAtomSet(agentDryRunVariableAnswerMutation, {
    mode: "promise",
  });
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  const label = `${decision.variable?.flowName}/${decision.variable?.name}`;
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
      private={masked}
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
 * Variables here, and an Example Run takes its bundled flow's private inputs.
 */
export const WorkspaceVariables = ({
  collapse,
  description,
  heading,
  masked,
  session,
}: {
  /** The Requests island's collapse control. */
  readonly collapse?: React.ReactNode;
  readonly description: string;
  readonly heading: string;
  /** Whether the values are private, so typed masked. */
  readonly masked: boolean;
  readonly session: AgentSessionSnapshot;
}) => {
  const { answers, pending } = runtimeVariables(session);
  if (pending.length === 0 && answers.length === 0) {
    return null;
  }
  return (
    <section aria-label={heading} className="space-y-3">
      <RequestHeader
        action={collapse}
        badge={
          <span className="tabular-nums">
            {stillNeeded(pending.length, pending.length + answers.length)}
          </span>
        }
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title={heading}
      />
      <RequestNote>{description}</RequestNote>
      <div className="space-y-3.5">
        {pending.map((decision) => (
          <PrerequisiteVariable
            decision={decision}
            key={decision.pendingDecisionId}
            masked={masked}
            sessionId={session.id}
          />
        ))}
      </div>
      <AnsweredVariables
        answers={answers.map((answer) => ({
          key: JSON.stringify([answer.flowName, answer.name]),
          label: `${answer.flowName}/${answer.name}`,
          status: answer.lastAnswer ?? "",
        }))}
      />
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
    description="The agent sees whether you answered, never the value."
    heading="Prerequisite Variables"
    masked
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
    description="The demo account takes any password of 8 or more characters. The agent sees whether you answered, never the value."
    heading="Example private inputs"
    masked
    session={session}
  />
);
