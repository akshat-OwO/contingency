import { OperationId } from "@contingency/protocol";
import type { AgentSessionSnapshot } from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import { KeyRoundIcon, LoaderCircleIcon } from "lucide-react";
import { useId } from "react";

import {
  AnsweredVariables,
  RequestHeader,
  RequestInvalid,
  RequestMessage,
  RequestNote,
  requestIconClassName,
} from "@/components/agent/dock-request-parts";
import { takesTakeoverVariable } from "@/components/agent/dock-requests-state";
import type { TakeoverForm } from "@/components/agent/dock-requests-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;

const labelClassName = "text-[12.5px] font-medium";

const PrivateVariableForm = ({
  collapse,
  session,
  stateAtom,
}: {
  readonly collapse: React.ReactNode;
  readonly session: AgentSessionSnapshot;
  readonly stateAtom: Atom.Writable<TakeoverForm>;
}) => {
  const { agentTeachingVariableInputMutation } = useRpcDependencies();
  const enter = useAtomSet(agentTeachingVariableInputMutation, {
    mode: "promise",
  });
  const id = useId();
  const [state, setState] = useAtom(stateAtom);
  const nameMessageId = `${id}-name-message`;
  const errorId = `${id}-error`;
  return (
    <section aria-label="Takeover Variable" className="space-y-3">
      <RequestHeader
        action={collapse}
        badge="While you have control"
        icon={
          <KeyRoundIcon aria-hidden="true" className={requestIconClassName} />
        }
        title="Takeover Variable"
      />
      <RequestNote>
        Focus the page field first. The Timeline shows the value; the saved Flow
        keeps the name.
      </RequestNote>
      <form
        className="space-y-2.5"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          const { name, value } = state;
          if (!VARIABLE_NAME.test(name)) {
            setState((current) => ({ ...current, invalid: true }));
            return;
          }
          if (value === "") {
            return;
          }
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
                variable: { name, runtime: true },
              },
            });
            setState((current) => ({
              ...current,
              entered: [
                ...current.entered.filter((entered) => entered !== name),
                name,
              ],
              pending: false,
            }));
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
        <div className="grid gap-1.5">
          <label className={labelClassName} htmlFor={`${id}-name`}>
            Variable name
          </label>
          <Input
            aria-describedby={state.invalid ? nameMessageId : undefined}
            aria-invalid={state.invalid || undefined}
            autoComplete="off"
            className="h-[34px] font-mono"
            disabled={state.pending}
            id={`${id}-name`}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                invalid: false,
                name: event.target.value,
              }))
            }
            placeholder="PROMO_CODE"
            spellCheck={false}
            value={state.name}
            variant="island"
          />
          {state.invalid ? (
            <RequestInvalid id={nameMessageId}>
              Start with a capital letter. Use A–Z, 0–9 and _.
            </RequestInvalid>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <label className={labelClassName} htmlFor={`${id}-value`}>
            Variable value
          </label>
          <div className="flex min-w-0 items-center gap-1.5">
            <Input
              aria-describedby={state.error === "" ? undefined : errorId}
              autoComplete="off"
              className="h-[34px] min-w-0 flex-1 font-mono"
              disabled={state.pending}
              id={`${id}-value`}
              onChange={(event) =>
                setState((current) => ({
                  ...current,
                  value: event.target.value,
                }))
              }
              placeholder="Value"
              spellCheck={false}
              type="text"
              value={state.value}
              variant="island"
            />
            <Button
              aria-busy={state.pending || undefined}
              disabled={
                state.pending || state.name === "" || state.value === ""
              }
              size="island"
              type="submit"
            >
              {state.pending ? (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-3.5 animate-spin"
                />
              ) : null}
              Enter Variable
            </Button>
          </div>
        </div>
        <RequestMessage
          error={state.error === "" ? undefined : state.error}
          id={errorId}
          invalid={undefined}
        />
      </form>
      <AnsweredVariables
        answers={state.entered.map((name) => ({
          key: name,
          label: name,
          status: "entered",
        }))}
        label="Entered"
      />
    </section>
  );
};

/**
 * Private values enter the page through Teaching's existing masking path,
 * while the user holds the browser in a Guided recording (ADR 0052).
 */
export const GuidedTakeoverVariable = ({
  collapse,
  session,
  stateAtom,
}: {
  /** The Requests island's collapse control. */
  readonly collapse?: React.ReactNode;
  readonly session: AgentSessionSnapshot;
  /** Owned by the request tier, so collapsing it keeps the form. */
  readonly stateAtom: Atom.Writable<TakeoverForm>;
}) =>
  takesTakeoverVariable(session) ? (
    <PrivateVariableForm
      collapse={collapse}
      session={session}
      stateAtom={stateAtom}
    />
  ) : null;
