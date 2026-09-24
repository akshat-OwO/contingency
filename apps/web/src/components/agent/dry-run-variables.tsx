import type {
  AgentSessionId,
  AgentSessionVariableState,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  if (variable.supplied) {
    return <p>{variable.name} supplied</p>;
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setSupplyError(null);
        try {
          await supply({
            payload: {
              data: { name: variable.name, sessionId, value },
              type: "agent.dry-run.variable.supply",
            },
          });
          setValue("");
        } catch (error) {
          setSupplyError(failureMessage(error, "Could not supply the secret."));
        } finally {
          setPending(false);
        }
      }}
    >
      <label
        className="grid min-w-40 flex-1 gap-1"
        htmlFor={`dry-run-${variable.name}`}
      >
        <span>{variable.name}</span>
        <Input
          autoComplete="off"
          id={`dry-run-${variable.name}`}
          onChange={(event) => setValue(event.target.value)}
          required
          type="password"
          value={value}
        />
      </label>
      <Button disabled={pending || value.length === 0} type="submit">
        Supply secret
      </Button>
      {supplyError === null ? null : <p role="alert">{supplyError}</p>}
    </form>
  );
};

export const DryRunVariables = ({
  sessionId,
  variables,
}: {
  readonly sessionId: AgentSessionId;
  readonly variables: readonly AgentSessionVariableState[];
}) =>
  variables.length === 0 ? null : (
    <section
      aria-label="Dry Run secrets"
      className="bg-background space-y-2 rounded-lg border p-3 text-sm shadow-lg"
    >
      <h2 className="font-semibold">Dry Run secrets</h2>
      <p>
        Supply each secret here. The agent sees its name and supply status,
        never its value.
      </p>
      {variables.map((variable) => (
        <SecretVariable
          key={variable.name}
          sessionId={sessionId}
          variable={variable}
        />
      ))}
    </section>
  );
