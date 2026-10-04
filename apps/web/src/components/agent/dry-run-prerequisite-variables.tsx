import { OperationId } from "@contingency/protocol";
import type {
  AgentPendingDecision,
  AgentSessionId,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { failureMessage } from "@/lib/failure-message";
import { useRpcDependencies } from "@/lib/rpc-dependencies";

const PrerequisiteVariable = ({
  sessionId,
  decision,
}: {
  readonly sessionId: AgentSessionId;
  readonly decision: AgentPendingDecision;
}) => {
  const { agentDryRunVariableAnswerMutation } = useRpcDependencies();
  const answer = useAtomSet(agentDryRunVariableAnswerMutation, {
    mode: "promise",
  });
  const [stateAtom] = useState(() =>
    Atom.make({ error: "", pending: false, value: "" })
  );
  const [state, setState] = useAtom(stateAtom);
  const label = `${decision.variable?.flowSkillName}/${decision.variable?.name}`;
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
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        await submit(state.value);
      }}
    >
      <label className="grid gap-1" htmlFor={decision.pendingDecisionId}>
        <span>{label}</span>
        <Input
          id={decision.pendingDecisionId}
          autoComplete="off"
          type="password"
          required
          value={state.value}
          disabled={state.pending}
          onChange={(event) =>
            setState((current) => ({ ...current, value: event.target.value }))
          }
        />
      </label>
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={state.pending || state.value.length === 0}
        >
          Supply {label}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={state.pending}
          onClick={async () => {
            await submit(null);
          }}
        >
          Refuse {label}
        </Button>
      </div>
      {state.error === "" ? null : <p role="alert">{state.error}</p>}
    </form>
  );
};

/**
 * Private inputs the user supplies or refuses in Workspace. The agent sees
 * each one's status, never its value. A Dry Run takes its prerequisite
 * Variables here, and an Example Run takes its bundled skill's private inputs.
 */
export const WorkspaceVariables = ({
  description,
  heading,
  session,
}: {
  readonly description: string;
  readonly heading: string;
  readonly session: AgentSessionSnapshot;
}) => {
  const pending = session.pendingDecisions.filter(
    (decision) => decision.kind === "supply_variable"
  );
  const pendingScopes = new Set(
    pending.map((decision) =>
      JSON.stringify([
        decision.variable?.flowSkillName,
        decision.variable?.name,
      ])
    )
  );
  const answers =
    session.run !== null && "schemaVersion" in session.run
      ? session.run.variables.filter(
          (variable) =>
            variable.lastAnswer !== undefined &&
            !pendingScopes.has(
              JSON.stringify([variable.flowSkillName, variable.name])
            )
        )
      : [];
  if (pending.length === 0 && answers.length === 0) {
    return null;
  }
  return (
    <section
      aria-label={heading}
      className="bg-background space-y-3 rounded-lg border p-3 text-sm shadow-lg"
    >
      <h2 className="font-semibold">{heading}</h2>
      <p>{description}</p>
      {pending.map((decision) => (
        <PrerequisiteVariable
          key={decision.pendingDecisionId}
          sessionId={session.id}
          decision={decision}
        />
      ))}
      {answers.map((answer) => (
        <p key={JSON.stringify([answer.flowSkillName, answer.name])}>
          {answer.flowSkillName}/{answer.name} {answer.lastAnswer}
        </p>
      ))}
    </section>
  );
};

export const DryRunPrerequisiteVariables = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => (
  <WorkspaceVariables
    description="Supply or refuse private prerequisite inputs here. The agent sees their status, never their values."
    heading="Prerequisite Variables"
    session={session}
  />
);

export const ExampleVariables = ({
  session,
}: {
  readonly session: AgentSessionSnapshot;
}) => (
  <WorkspaceVariables
    description="Supply or refuse this Example's private inputs here. The demo account accepts any password of at least 8 characters. The agent sees their status, never their values."
    heading="Example private inputs"
    session={session}
  />
);
