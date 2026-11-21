import type {
  AgentSessionId,
  AgentSessionVariableState,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
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
  splitWaiting,
  stillNeeded,
} from "@/components/agent/dock-requests-state";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const SecretVariable = ({
  sessionId,
  variable,
}: {
  readonly sessionId: AgentSessionId;
  readonly variable: AgentSessionVariableState;
}) => {
  const { agentDryRunVariableSupplyMutation } = useRpcDependencies();
  const supply = useAtomSet(agentDryRunVariableSupplyMutation, {
    mode: "promise",
  });
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [supplyError, setSupplyError] = useState<string | null>(null);

  return (
    <VariableField
      error={supplyError ?? undefined}
      id={`dry-run-${variable.name}`}
      label={variable.name}
      onSubmit={async () => {
        setPending(true);
        setSupplyError(null);
        try {
          await supply({
            payload: { name: variable.name, sessionId, value },
          });
          setValue("");
        } catch (error) {
          setSupplyError(
            failureMessage(error, "Could not supply the Variable.")
          );
        } finally {
          setPending(false);
        }
      }}
      onValueChange={setValue}
      pending={pending}
      private
      supplyLabel={`Supply ${variable.name}`}
      value={value}
    />
  );
};

export const DryRunVariables = ({
  collapse,
  sessionId,
  variables,
}: {
  /** The Requests island's collapse control. */
  readonly collapse?: React.ReactNode;
  readonly sessionId: AgentSessionId;
  readonly variables: readonly AgentSessionVariableState[];
}) => {
  const [waiting, supplied] = splitWaiting(
    variables,
    (variable) => !variable.supplied
  );
  if (waiting.length === 0) {
    return null;
  }
  return (
    <section aria-label="Dry Run Variables" className="space-y-3">
      <RequestHeader
        action={collapse}
        badge={
          <span className="tabular-nums">
            {stillNeeded(waiting.length, variables.length)}
          </span>
        }
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title="Dry Run Variables"
      />
      <RequestNote>Values are visible in journey evidence.</RequestNote>
      <div className="space-y-3.5">
        {waiting.map((variable) => (
          <SecretVariable
            key={variable.name}
            sessionId={sessionId}
            variable={variable}
          />
        ))}
      </div>
      <AnsweredVariables
        answers={supplied.map((variable) => ({
          key: variable.name,
          label: variable.name,
          status: "supplied",
        }))}
      />
    </section>
  );
};
