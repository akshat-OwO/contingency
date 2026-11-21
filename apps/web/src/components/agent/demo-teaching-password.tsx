import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

import { RequestHeader, requestIconClassName } from "./dock-request-parts";
import { hasDemoTeachingPassword } from "./run-provenance";

/**
 * Sign-in belongs in the user's recording when their variation needs a
 * password. It asks in the Requests island, which Teaching otherwise leaves
 * free, so it never covers the page the user is signing in on.
 */
export const DemoTeachingPassword = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => {
  const { agentTeachingVariableInputMutation } = useRpcDependencies();
  const enter = useAtomSet(agentTeachingVariableInputMutation, {
    mode: "promise",
  });
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  if (!hasDemoTeachingPassword(session)) {
    return null;
  }
  return (
    <div className="border-b p-3.5">
      <section aria-label="Teaching demo password" className="space-y-2.5">
        <RequestHeader
          badge="Demo sign-in"
          icon={
            <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
          }
          title="Record sign-in with a test password"
        />
        <ol className="text-muted-foreground list-decimal pl-[18px] text-[12.5px]">
          <li>Click the store's Password field.</li>
          <li>Enter a demo password here, then continue in the store.</li>
        </ol>
        <form
          className="flex flex-wrap items-center gap-2"
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
          <Input
            aria-label="Demo password"
            autoComplete="off"
            className="h-10 min-w-40 flex-1 font-mono"
            disabled={state.pending}
            minLength={8}
            onChange={(event) =>
              setState((current) => ({ ...current, value: event.target.value }))
            }
            placeholder="At least 8 characters"
            required
            type="text"
            value={state.value}
          />
          <Button
            variant="primary"
            disabled={state.pending || state.value.length < 8}
            size="island-lg"
            type="submit"
          >
            Enter demo password
          </Button>
        </form>
        {state.error === "" ? (
          <p className="text-muted-foreground text-xs">
            Your recording keeps{" "}
            <code className="bg-island-hover rounded-[5px] px-[5px] py-px font-mono text-xs">
              DEMO_PASSWORD
            </code>{" "}
            in place of the value.
          </p>
        ) : (
          <p
            className="bg-status-recording/12 text-status-recording rounded-[10px] px-2.5 py-[7px] text-[12.5px]"
            role="alert"
          >
            {state.error}
          </p>
        )}
      </section>
    </div>
  );
};
