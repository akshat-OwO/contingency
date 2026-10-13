import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type {
  AndroidWorkspaceCommand,
  AndroidWorkspaceSelection,
  AndroidWorkspaceSnapshot,
} from "@contingency/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Effect, Fiber, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { useEffect } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { androidSessionsAtom, runAndroidWorkspaceCommand } from "@/lib/rpc";

import {
  sessionStartGestureAtom,
  useWorkspaceGesture,
} from "./workspace-gesture";

interface WorkspaceState {
  readonly session: AndroidWorkspaceSnapshot | null;
  readonly text: string;
  readonly instruction: string;
  readonly failure: string | null;
}
const workspaceAtom = Atom.make<WorkspaceState>({
  failure: null,
  instruction: "",
  session: null,
  text: "Public fixture text",
});
const applySnapshot = (
  current: WorkspaceState,
  session: AndroidWorkspaceSnapshot
): WorkspaceState =>
  current.session?.id === session.id &&
  current.session.revision > session.revision
    ? current
    : { ...current, failure: null, session };
const operationId = () =>
  OperationId.make(`workspace-android-${crypto.randomUUID()}`);
const message = (cause: unknown) =>
  Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(
    cause
  ).pipe(
    Option.map((value) => value.message),
    Option.getOrElse(() => "Android Workspace is unavailable.")
  );
const selected = (form: HTMLFormElement, name: string) =>
  String(new FormData(form).get(name) ?? "").trim();
const condition = (form: HTMLFormElement, prefix: string) => ({
  name: selected(form, `${prefix}Name`),
  role: selected(form, `${prefix}Role`),
});
const selection = (form: HTMLFormElement): AndroidWorkspaceSelection => ({
  device: {
    api: 36,
    avd: selected(form, "avd"),
    fingerprint: selected(form, "fingerprint"),
    host: "local",
    serial: selected(form, "serial"),
  },
  environment: {
    androidVersion: selected(form, "androidVersion"),
    appBuild: selected(form, "appBuild"),
    appId: selected(form, "appId"),
    startingState: selected(form, "startingState"),
  },
  helperConsent: Schema.decodeUnknownOption(
    Schema.Literals(["none", "install", "replace"])
  )(selected(form, "helperConsent")).pipe(
    Option.getOrElse(() => "none" as const)
  ),
  outcomes: [condition(form, "outcome")],
  reversibleActions: selected(form, "actionName")
    ? [condition(form, "action")]
    : [],
  setup: {
    activity: selected(form, "activity"),
    conditions: [condition(form, "starting")],
    kind: "restart-activity",
  },
});
const Field = ({
  name,
  label,
  defaultValue,
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultValue?: string;
}) => (
  <label className="grid gap-1 text-sm">
    {label}
    <Input name={name} defaultValue={defaultValue} required />
  </label>
);
const Limits = () => (
  <p className="text-muted-foreground text-sm">
    Experimental local API 36 emulator. Semantic actions and public fixture text
    only. No private Variables, coordinates, arbitrary keys, cross-app input, or
    system-dialog permissions. Ownership and dispatch use experimental host
    checks. Screenshots and semantic snapshots are separate captures. Direct
    device touches are outside Teaching capture.
  </p>
);

interface AndroidViewProps {
  readonly session: AndroidWorkspaceSnapshot;
  readonly state: WorkspaceState;
  readonly setState: (
    update: (current: WorkspaceState) => WorkspaceState
  ) => void;
  readonly mutate: (command: AndroidWorkspaceCommand) => boolean;
  readonly input: (
    action: Extract<
      AndroidWorkspaceCommand,
      { readonly _tag: "input" }
    >["action"]
  ) => void;
  readonly pending: boolean;
  readonly available: boolean;
  readonly lifecycle: string | undefined;
  readonly observation: AndroidWorkspaceSnapshot["observation"] | undefined;
}
const AndroidStatus = ({
  session,
  setState,
  mutate,
  pending,
  available,
  lifecycle,
}: AndroidViewProps) => (
  <>
    {" "}
    <section
      aria-label="Android session status"
      className="grid gap-2 rounded-xl border p-4"
    >
      <p>
        {session.flowSkillName} · {session.kind} · {session.phase} ·{" "}
        {session.controller} control
      </p>
      <p>
        Bound emulator {session.selection.device.serial} ·{" "}
        {session.selection.device.avd} · Target App{" "}
        {session.selection.environment.appId}
      </p>
      <p>
        Helper consent: {session.selection.helperConsent}. Preparation:{" "}
        {session.preparation.phase}. Teaching: {lifecycle ?? "not recording"}.
      </p>
      {session.recordingId ? (
        <p>Teaching Recording: {session.recordingId}</p>
      ) : null}
      {session.preparation.differences.map((difference) => (
        <p key={difference.field}>
          {difference.field}: taught {difference.taught}, selected{" "}
          {difference.selected}
        </p>
      ))}
      {session.preparation.pending.map((decision) => (
        <div
          key={decision.id}
          role="group"
          aria-label="Run Environment Permission"
        >
          <p>
            {decision.kind} for {decision.targetApp}
          </p>
          <Button
            disabled={pending}
            onClick={() =>
              mutate({
                _tag: "decide",
                allow: true,
                decisionId: decision.id,
                operationId: operationId(),
                sessionId: session.id,
              })
            }
          >
            Allow
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              mutate({
                _tag: "decide",
                allow: false,
                decisionId: decision.id,
                operationId: operationId(),
                sessionId: session.id,
              })
            }
          >
            Refuse
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {session.phase === "pending" ? (
          <Button
            disabled={pending || session.preparation.pending.length > 0}
            onClick={() =>
              mutate({
                _tag: "prepare",
                operationId: operationId(),
                sessionId: session.id,
              })
            }
          >
            Prepare selected emulator
          </Button>
        ) : null}
        {session.phase === "paused" ? (
          <Button
            disabled={pending}
            onClick={() =>
              mutate({
                _tag: "recover",
                operationId: operationId(),
                sessionId: session.id,
              })
            }
          >
            Recover same emulator
          </Button>
        ) : null}
        {session.kind === "teaching" &&
        (lifecycle === "setup" || lifecycle === "recording") ? (
          <Button
            disabled={!available}
            onClick={() =>
              mutate({
                _tag: "record",
                operationId: operationId(),
                sessionId: session.id,
                start: lifecycle === "setup",
              })
            }
          >
            {lifecycle === "recording" ? "Stop recording" : "Start recording"}
          </Button>
        ) : null}
        {session.kind !== "teaching" && session.phase === "running" ? (
          <Button
            disabled={pending}
            onClick={() =>
              mutate({
                _tag: "control",
                controller: session.controller === "user" ? "agent" : "user",
                operationId: operationId(),
                sessionId: session.id,
              })
            }
          >
            {session.controller === "user" ? "Return control" : "Take control"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            mutate({
              _tag: "close",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
        >
          Close session
        </Button>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => setState((current) => ({ ...current, session: null }))}
        >
          New Android session
        </Button>
      </div>
    </section>
  </>
);
const AndroidMirror = ({
  session,
  state,
  setState,
  mutate,
  input,
  pending,
  available,
  lifecycle,
  observation,
}: AndroidViewProps) => (
  <>
    {" "}
    <section
      className="grid gap-4 md:grid-cols-2"
      aria-label="Mirrored Android Workspace"
    >
      <div className="grid place-items-center rounded-xl border bg-black/90 p-2">
        {observation?.image ? (
          <img
            src={`data:image/png;base64,${observation.image}`}
            width={observation.width}
            height={observation.height}
            className="max-h-[65vh] max-w-full object-contain"
            alt="Selected emulator mirrored screen"
          />
        ) : (
          <p className="text-white">Prepare the emulator to view its screen.</p>
        )}
      </div>
      <div className="grid content-start gap-3">
        <label>
          Public fixture text
          <Input
            aria-label="Public fixture text"
            value={state.text}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                text: event.target.value,
              }))
            }
          />
        </label>
        <Button
          disabled={!available || !observation}
          onClick={() => input({ _tag: "back" })}
        >
          Android Back
        </Button>
        <div
          role="group"
          aria-label="Semantic Android controls"
          className="grid max-h-[50vh] gap-2 overflow-auto"
        >
          {observation?.nodes.flatMap((node) =>
            node.password ||
            node.covered ||
            (!node.editable &&
              !(
                session.requirements.platform === "android" &&
                session.requirements.reversibleActions?.some(
                  (allowed) =>
                    allowed.role === node.role && allowed.name === node.name
                )
              ))
              ? []
              : [
                  <Button
                    key={node.target}
                    variant="outline"
                    disabled={!available}
                    onClick={() =>
                      input(
                        node.editable
                          ? {
                              _tag: "fill",
                              target: node.target,
                              text: state.text,
                            }
                          : { _tag: "activate", target: node.target }
                      )
                    }
                  >
                    {node.editable ? "Enter public text in" : "Activate"}{" "}
                    {node.role} {node.name}
                  </Button>,
                ]
          )}
        </div>
        {lifecycle === "recording" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutate({
                _tag: "instruction",
                operationId: operationId(),
                sessionId: session.id,
                text: state.instruction,
              });
            }}
          >
            <label>
              Instruction
              <Input
                value={state.instruction}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    instruction: event.target.value,
                  }))
                }
                required
              />
            </label>
            <Button disabled={pending} type="submit">
              Add Instruction
            </Button>
          </form>
        ) : null}
      </div>
    </section>
  </>
);
const AndroidResults = ({
  session,
  mutate,
  pending,
  lifecycle,
}: AndroidViewProps) => (
  <>
    {" "}
    {lifecycle === "dry-run-passed" ? (
      <div className="flex gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            mutate({
              _tag: "flow-decision",
              decision: "verify",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
        >
          Verify flow
        </Button>
        <Button
          disabled={pending}
          onClick={() =>
            mutate({
              _tag: "flow-decision",
              decision: "reject",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
        >
          Reject flow
        </Button>
      </div>
    ) : null}
    {session.cleanup?._tag === "purge-pending" ? (
      <section aria-label="Cleanup">
        <p>{session.cleanup.failure}</p>
        <p>Retained files: {session.cleanup.retainedFiles.join(", ")}</p>
        <Button
          onClick={() =>
            mutate({
              _tag: "flow-decision",
              decision: "retry-cleanup",
              operationId: operationId(),
              sessionId: session.id,
            })
          }
        >
          Retry Cleanup
        </Button>
      </section>
    ) : null}
    {session.cleanup?._tag === "purged" ? (
      <p>Cleanup completed. Verified Flow Skill retained.</p>
    ) : null}
    <section aria-label="Android Run Summary">
      <h2 className="font-semibold">Run Summary</h2>
      <p>Agent Assessment: {session.assessment?.outcome ?? "not submitted"}</p>
      <p>{session.assessment?.explanation}</p>
      <p>
        Takeover:{" "}
        {session.takeoverOccurred ? "occurred; Dry Run cannot pass" : "none"}
      </p>
      <p>Capture gaps: {session.captureGaps.join(", ") || "none"}</p>
      <p>{session.error}</p>
      <ul>
        {session.preparation.evidence.map((entry) => (
          <li
            key={`${entry.type}-${entry.observationId ?? entry.decisionId ?? entry.code ?? "status"}`}
          >
            {entry.type} {entry.code} {entry.observationId} {entry.decisionId}
          </li>
        ))}
      </ul>
    </section>
  </>
);

export const AndroidWorkspace = ({
  requestedSessionId,
  onBrowser,
}: {
  readonly requestedSessionId?: string | undefined;
  readonly onBrowser: () => void;
}) => {
  const [state, setState] = useAtom(workspaceAtom);
  const sessions = useAtomValue(androidSessionsAtom);
  const refresh = useAtomRefresh(androidSessionsAtom);
  const gesture = useWorkspaceGesture(sessionStartGestureAtom);
  const dispatch = (command: AndroidWorkspaceCommand) =>
    gesture.dispatch(
      runAndroidWorkspaceCommand(command).pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            setState((current) => applySnapshot(current, session));
            refresh();
          })
        ),
        Effect.mapError(message),
        Effect.asVoid
      )
    );
  useEffect(() => {
    if (
      requestedSessionId === undefined ||
      !Schema.is(AgentSessionId)(requestedSessionId)
    ) {
      return;
    }
    const fiber = Effect.runFork(
      runAndroidWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((session) =>
          Effect.sync(() =>
            setState((current) => applySnapshot(current, session))
          )
        ),
        Effect.catchCause((failureCause) =>
          Effect.sync(() =>
            setState((current) => ({
              ...current,
              failure: Cause.pretty(failureCause),
            }))
          )
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, setState]);
  const id = state.session?.id;
  const running = state.session?.phase === "running";
  useEffect(() => {
    if (id === undefined || !running) {
      return;
    }
    const reportMirrorFailure = (failureCause: Cause.Cause<unknown>) =>
      runAndroidWorkspaceCommand({ _tag: "read", sessionId: id }).pipe(
        Effect.tap((session) =>
          Effect.sync(() =>
            setState((current) => ({
              ...current,
              failure: Cause.pretty(failureCause),
              session,
            }))
          )
        ),
        Effect.ignore
      );
    const fiber = Effect.runFork(
      Effect.forever(
        Effect.gen(function* mirrorSelectedDevice() {
          const session = yield* runAndroidWorkspaceCommand({
            _tag: "observe",
            image: true,
            sessionId: id,
          });
          yield* Effect.sync(() =>
            setState((current) =>
              current.session?.id === id
                ? applySnapshot(current, session)
                : current
            )
          );
          yield* Effect.sleep("1 second");
        })
      ).pipe(Effect.catchCause(reportMirrorFailure))
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id, running, setState]);
  const { session } = state;
  const mutate = (command: AndroidWorkspaceCommand) => dispatch(command);
  const start = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = selected(form, "flowSkillName");
    if (!Schema.is(FlowSkillName)(name)) {
      setState((current) => ({
        ...current,
        failure: "Choose a valid Flow Skill name.",
      }));
      return;
    }
    mutate({
      _tag: "start",
      flowSkillName: name,
      kind: "teaching",
      operationId: operationId(),
      recordingId: null,
      selection: selection(form),
    });
  };
  const input = (
    action: Extract<
      AndroidWorkspaceCommand,
      { readonly _tag: "input" }
    >["action"]
  ) => {
    if (session?.observation) {
      mutate({
        _tag: "input",
        action,
        observationId: session.observation.id,
        operationId: operationId(),
        sessionId: session.id,
      });
    }
  };
  const available =
    session?.controller === "user" &&
    session.phase === "running" &&
    !gesture.pending;
  const observation = session?.observation;
  const lifecycle = session?.captureState?._tag;
  return (
    <main className="mx-auto grid h-full max-w-7xl gap-4 overflow-auto p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">
          Contingency · Android experimental
        </h1>
        <Button variant="outline" onClick={onBrowser}>
          Browser Workspace
        </Button>
      </header>
      <Limits />
      {gesture.error || state.failure ? (
        <p role="alert">{gesture.error ?? state.failure}</p>
      ) : null}
      {AsyncResult.isSuccess(sessions) && sessions.value.length > 0 ? (
        <label>
          Android Agent Session
          <select
            aria-label="Android Agent Session"
            value={session?.id ?? ""}
            onChange={(event) => {
              const { value } = event.currentTarget;
              if (Schema.is(AgentSessionId)(value)) {
                mutate({ _tag: "read", sessionId: value });
              }
            }}
          >
            <option value="">Select explicitly</option>
            {sessions.value.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.flowSkillName} · {entry.kind} · {entry.phase} ·{" "}
                {entry.selection.device.serial}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {session === null ? (
        <form
          onSubmit={start}
          className="grid max-w-2xl gap-3 sm:grid-cols-2"
          aria-label="Select Android emulator and Target App"
        >
          <Field name="flowSkillName" label="Flow Skill name" />
          <Field name="serial" label="Selected emulator serial" />
          <Field name="avd" label="Selected AVD" />
          <Field name="fingerprint" label="Selected build fingerprint" />
          <Field
            name="androidVersion"
            label="Android release"
            defaultValue="16"
          />
          <Field name="appId" label="Target App package" />
          <Field name="appBuild" label="Target App versionCode" />
          <Field name="activity" label="Starting activity" />
          <Field name="startingState" label="Starting state description" />
          <Field name="startingRole" label="Starting condition role" />
          <Field name="startingName" label="Starting condition name" />
          <Field name="actionRole" label="Reversible action role" />
          <Field name="actionName" label="Reversible action name" />
          <Field name="outcomeRole" label="Required outcome role" />
          <Field name="outcomeName" label="Required outcome name" />
          <label>
            Helper authorization
            <select name="helperConsent" aria-label="Helper authorization">
              <option value="none">Use compatible installed helper only</option>
              <option value="install">
                Authorize pinned helper installation
              </option>
              <option value="replace">
                Authorize pinned helper replacement
              </option>
            </select>
          </label>
          <Button disabled={gesture.pending} type="submit">
            Open experimental Android session
          </Button>
        </form>
      ) : (
        <>
          <AndroidStatus
            session={session}
            state={state}
            setState={setState}
            mutate={mutate}
            input={input}
            pending={gesture.pending}
            available={available}
            lifecycle={lifecycle}
            observation={observation}
          />
          <AndroidMirror
            session={session}
            state={state}
            setState={setState}
            mutate={mutate}
            input={input}
            pending={gesture.pending}
            available={available}
            lifecycle={lifecycle}
            observation={observation}
          />
          <AndroidResults
            session={session}
            state={state}
            setState={setState}
            mutate={mutate}
            input={input}
            pending={gesture.pending}
            available={available}
            lifecycle={lifecycle}
            observation={observation}
          />
        </>
      )}
    </main>
  );
};
