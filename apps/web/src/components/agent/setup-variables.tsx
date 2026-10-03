import { OperationId } from "@contingency/protocol";
import type {
  AgentSessionSnapshot,
  AgentSessionId,
  AgentSetupVariable,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        await submit(state.value);
      }}
    >
      <label className="grid gap-1" htmlFor={variable.requestId}>
        <span>{variable.name}</span>
        <Input
          aria-describedby={`${variable.requestId}-purpose`}
          id={variable.requestId}
          type="password"
          autoComplete="off"
          required
          value={state.value}
          disabled={state.pending}
          onChange={(event) =>
            setState((current) => ({ ...current, value: event.target.value }))
          }
        />
      </label>
      <p className="text-muted-foreground" id={`${variable.requestId}-purpose`}>
        {variable.purpose}
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={state.pending || state.value.length === 0}
        >
          Supply {variable.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={state.pending}
          onClick={async () => {
            await submit(null);
          }}
        >
          Refuse {variable.name}
        </Button>
      </div>
      {state.error === "" ? null : <p role="alert">{state.error}</p>}
    </form>
  );
};

export const SetupVariables = ({
  session,
}: {
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
  return (
    <section
      aria-label="Setup Variables"
      className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
    >
      <h2 className="font-semibold">Setup Variables</h2>
      <p>
        Supply private setup inputs here. The agent sees their status, never
        their values.
      </p>
      {variables.map((variable) =>
        variable.status === "requested" ? (
          <SetupVariable
            key={`${session.id}/${variable.requestId}`}
            sessionId={session.id}
            variable={variable}
          />
        ) : (
          <p key={variable.requestId}>
            {variable.name} {variable.status}
          </p>
        )
      )}
    </section>
  );
};
