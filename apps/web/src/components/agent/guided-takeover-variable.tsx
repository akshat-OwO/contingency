import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const PrivateVariableForm = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { agentTeachingVariableInputMutation } = useRpcDependencies();
  const enter = useAtomSet(agentTeachingVariableInputMutation, {
    mode: "promise",
  });
  const id = useId();
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", name: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  return (
    <section
      aria-label="Private Takeover Variable"
      className="space-y-2 border-b p-3 text-sm"
    >
      <p>
        Focus the browser field first. Enter its secret here so the recording
        keeps a Variable reference.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const { name, value } = state;
          setState((current) => ({
            ...current,
            error: "",
            pending: true,
            value: "",
          }));
          try {
            await enter({
              payload: {
                operationId: OperationId.make(crypto.randomUUID()),
                sessionId: session.id,
                value,
                variable: { name, runtime: true, secret: true },
              },
            });
            setState((current) => ({ ...current, pending: false }));
          } catch (error) {
            setState((current) => ({
              ...current,
              error: failureMessage(
                error,
                "Could not enter the Variable. Focus the browser field and try again."
              ),
              pending: false,
            }));
          }
        }}
      >
        <label htmlFor={`${id}-name`} className="grid gap-1">
          Variable name
          <Input
            id={`${id}-name`}
            value={state.name}
            pattern="[A-Z][A-Z0-9_]*"
            title="Start with an uppercase letter. Use uppercase letters, numbers, and underscores."
            required
            disabled={state.pending}
            onChange={(event) =>
              setState((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label htmlFor={`${id}-value`} className="grid gap-1">
          Secret value
          <Input
            id={`${id}-value`}
            type="password"
            autoComplete="off"
            value={state.value}
            required
            disabled={state.pending}
            onChange={(event) =>
              setState((current) => ({ ...current, value: event.target.value }))
            }
          />
        </label>
        <Button type="submit" disabled={state.pending}>
          Enter Variable
        </Button>
        {state.error === "" ? null : <p role="alert">{state.error}</p>}
      </form>
    </section>
  );
};

/** Private values enter the page through Teaching's existing masking path. */
export const GuidedTakeoverVariable = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  if (
    session.activity !== "teaching" ||
    session.origin !== "guided-run" ||
    session.captureState._tag !== "recording" ||
    session.controller !== "user"
  ) {
    return null;
  }
  return <PrivateVariableForm session={session} />;
};
