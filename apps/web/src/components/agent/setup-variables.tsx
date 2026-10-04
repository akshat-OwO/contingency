import { OperationId } from "@contingency/protocol";
import type {
  AgentSessionSnapshot,
  AgentSessionId,
  AgentSetupVariable,
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
import { splitWaiting } from "@/components/agent/dock-requests-state";
import { Badge } from "@/components/ui/badge";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const SetupVariable = ({
  sessionId,
  variable,
}: {
  readonly sessionId: AgentSessionId;
  readonly variable: AgentSetupVariable;
}) => {
  const { agentSetupVariableAnswerMutation } = useRpcDependencies();
  const answer = useAtomSet(agentSetupVariableAnswerMutation, {
    mode: "promise",
  });
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  const submit = async (value: string | null) => {
    setState((current) => ({ ...current, error: "", pending: true }));
    try {
      await answer({
        payload: {
          operationId: OperationId.make(crypto.randomUUID()),
          requestId: variable.requestId,
          sessionId,
          value,
        },
      });
      setState({ error: "", pending: false, value: "" });
    } catch (error) {
      setState({
        error: failureMessage(error, "Could not answer the setup request."),
        pending: false,
        value: "",
      });
    }
  };
  return (
    <VariableField
      error={state.error === "" ? undefined : state.error}
      id={variable.requestId}
      label={variable.name}
      onRefuse={async () => {
        await submit(null);
      }}
      onSubmit={async () => {
        await submit(state.value);
      }}
      onValueChange={(value) => setState((current) => ({ ...current, value }))}
      pending={state.pending}
      purpose={variable.purpose}
      refuseLabel={`Refuse ${variable.name}`}
      supplyLabel={`Supply ${variable.name}`}
      value={state.value}
    />
  );
};

export const SetupVariables = ({
  collapse,
  session,
}: {
  /** The tier's collapse control, when this is its first request. */
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
}) => {
  if (
    session.activity !== "teaching" ||
    session.controller !== "agent" ||
    session.captureState._tag !== "setup"
  ) {
    return null;
  }
  const variables = session.setupVariables ?? [];
  if (variables.length === 0) {
    return null;
  }
  const [waiting, answered] = splitWaiting(
    variables,
    ({ status }) => status === "requested"
  );
  return (
    <section aria-label="Setup Variables" className="space-y-2">
      <RequestHeader
        action={
          <>
            <span className="text-muted-foreground hidden text-xs @xl:inline">
              The agent sees status, never values
            </span>
            {collapse}
          </>
        }
        badge={
          <Badge variant="secondary">
            {waiting.length} of {variables.length} needed
          </Badge>
        }
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title="Setup Variables"
      />
      <p className="text-muted-foreground text-xs @xl:hidden">
        Supply private setup inputs here. The agent sees their status, never
        their values.
      </p>
      <div className="space-y-2.5">
        {waiting.map((variable) => (
          <SetupVariable
            key={`${session.id}/${variable.requestId}`}
            sessionId={session.id}
            variable={variable}
          />
        ))}
      </div>
      {answered.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {answered.map((variable) => (
            <AnsweredVariable
              key={variable.requestId}
              label={variable.name}
              status={variable.status}
            />
          ))}
        </div>
      )}
    </section>
  );
};
