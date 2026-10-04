import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { hasDemoTeachingPassword } from "./run-provenance";

/** Sign-in belongs in the user's recording when their variation needs a password. */
export const DemoTeachingPassword = ({
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
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  if (!hasDemoTeachingPassword(session)) {
    return null;
  }
  return (
    <section
      aria-label="Teaching demo password"
      className="bg-background space-y-2 rounded-lg border p-3 text-sm shadow-lg"
    >
      <h2 className="font-semibold">Record sign-in with a private password</h2>
      <p>
        Click the store's Password field first. Enter a demo password here, then
        continue in the store. Your recording keeps DEMO_PASSWORD in place of
        its value.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const { value } = state;
          setState({ error: "", pending: true, value: "" });
          try {
            await enter({
              payload: {
                operationId: OperationId.make(crypto.randomUUID()),
                sessionId: session.id,
                value,
                variable: {
                  name: "DEMO_PASSWORD",
                  runtime: true,
                  secret: true,
                },
              },
            });
            setState({ error: "", pending: false, value: "" });
          } catch (error) {
            setState({
              error: failureMessage(
                error,
                "Could not enter the demo password. Click the store's Password field and try again."
              ),
              pending: false,
              value: "",
            });
          }
        }}
      >
        <label className="grid min-w-40 flex-1 gap-1" htmlFor={id}>
          <span>Demo password</span>
          <Input
            id={id}
            type="password"
            autoComplete="off"
            minLength={8}
            required
            disabled={state.pending}
            value={state.value}
            onChange={(event) =>
              setState((current) => ({ ...current, value: event.target.value }))
            }
          />
        </label>
        <Button
          type="submit"
          disabled={state.pending || state.value.length < 8}
        >
          Enter demo password
        </Button>
        {state.error === "" ? null : <p role="alert">{state.error}</p>}
      </form>
    </section>
  );
};
