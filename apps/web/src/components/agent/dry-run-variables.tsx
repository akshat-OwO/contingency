import type {
  AgentSessionId,
  AgentSessionVariableState,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
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
          setSupplyError(failureMessage(error, "Could not supply the secret."));
        } finally {
          setPending(false);
        }
      }}
      onValueChange={setValue}
      pending={pending}
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
  /** The tier's collapse control, when this is its first request. */
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
    <section aria-label="Dry Run secrets" className="space-y-2">
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
        title="Dry Run secrets"
      />
      <div className="space-y-2.5">
        {waiting.map((variable) => (
          <SecretVariable
            key={variable.name}
            sessionId={sessionId}
            variable={variable}
          />
        ))}
      </div>
      {supplied.length === 0 ? null : (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {supplied.map((variable) => (
            <AnsweredVariable
              key={variable.name}
              label={variable.name}
              status="supplied"
            />
          ))}
        </div>
      )}
    </section>
  );
};
