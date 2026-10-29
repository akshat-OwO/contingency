/* oxlint-disable eslint/no-await-in-loop -- Decode each transport packet in order and release its reader on cancellation. */
import {
  AgentSessionId,
  FlowSkillName,
  OperationId,
} from "@contingency/protocol";
import type {
  IosWorkspaceCommand,
  IosWorkspaceSnapshot,
  IosWorkspaceSelection,
} from "@contingency/protocol";
import {
  useAtom,
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
} from "@effect/atom-react";
import { Effect, Fiber, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  iosDevicesAtom,
  iosSessionsAtom,
  iosEnabledAtom,
  iosStreamAccess,
  runIosWorkspaceCommand,
} from "@/lib/rpc";

import { workspaceChromeAtom } from "./agent-workspace-state";
import { AndroidVariables } from "./android-dock";
import { Wordmark } from "./workspace-dock";
import { useWorkspaceGesture } from "./workspace-gesture";

const snapshotAtom = Atom.make<IosWorkspaceSnapshot | null>(null);
const commandAtom = Atom.keepAlive(
  Atom.fn(
    (request: { readonly run: Effect.Effect<void, string> }) => request.run
  )
);
const operationId = () =>
  OperationId.make(`ios-workspace-${crypto.randomUUID()}`);
const text = (data: FormData, key: string) => String(data.get(key) ?? "");
const errorMessage = (cause: unknown) =>
  Schema.is(Schema.Struct({ message: Schema.String }))(cause)
    ? cause.message
    : "The iOS session is unavailable.";

export const IosEntry = () => {
  const enabled = useAtomValue(iosEnabledAtom);
  return AsyncResult.isSuccess(enabled) && enabled.value ? (
    <Button
      onClick={() => globalThis.location.assign("/?ios=new")}
      size="sm"
      variant="outline"
    >
      iOS
    </Button>
  ) : null;
};

const IosMirror = ({
  session,
  onPick,
}: {
  readonly session: IosWorkspaceSnapshot;
  readonly onPick: (
    point: { x: number; y: number },
    frame: { width: number; height: number }
  ) => void;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{
    readonly id: number;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  const [gestureError, setGestureError] = useState<string | null>(null);
  const [transport, setTransport] = useState("connecting");
  const live = session.phase === "running" || session.phase === "paused";
  useEffect(() => {
    if (!live) {
      return;
    }
    const fiber = Effect.runFork(
      iosStreamAccess(session.id).pipe(
        Effect.flatMap((access) =>
          Effect.tryPromise({
            catch: () => new Error("iOS transport lost"),
            try: async (signal) => {
              const response = await fetch(access.path, {
                headers: { Authorization: `Bearer ${access.token}` },
                signal,
              });
              if (!response.ok || !response.body) {
                throw new Error("iOS transport unavailable");
              }
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let pending = "";
              try {
                while (!signal.aborted) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    break;
                  }
                  pending += decoder.decode(chunk.value, { stream: true });
                  let newline = pending.indexOf("\n");
                  while (newline !== -1) {
                    const value: unknown = JSON.parse(
                      pending.slice(0, newline)
                    );
                    pending = pending.slice(newline + 1);
                    if (
                      Schema.is(
                        Schema.Struct({
                          _tag: Schema.Literal("jpeg"),
                          data: Schema.String,
                          height: Schema.Number,
                          width: Schema.Number,
                        })
                      )(value)
                    ) {
                      const image = new Image();
                      image.src = `data:image/jpeg;base64,${value.data}`;
                      await image.decode();
                      const target = canvas.current;
                      if (target && !signal.aborted) {
                        target.width = value.width;
                        target.height = value.height;
                        target.getContext("2d")?.drawImage(image, 0, 0);
                        setTransport("live");
                      }
                    } else {
                      setTransport("transport_lost");
                    }
                    newline = pending.indexOf("\n");
                  }
                }
                if (!signal.aborted) {
                  setTransport("transport_lost");
                }
              } finally {
                await reader.cancel();
              }
            },
          })
        ),
        Effect.catchCause(() =>
          Effect.sync(() => setTransport("transport_lost"))
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [session.id, session.phase, live]);
  return (
    <div className="bg-muted/30 flex min-h-0 flex-1 flex-col items-center justify-center pb-52">
      <p role="status">
        {transport === "transport_lost" && live
          ? "iOS mirror paused. No input is sent until transport is restored."
          : ""}
      </p>
      {gestureError ? <p role="alert">{gestureError}</p> : null}
      <canvas
        data-observation-id={session.observation?.id}
        role="img"
        aria-label="Live iOS viewport"
        className="max-h-full max-w-full touch-none object-contain"
        ref={canvas}
        onPointerDown={(event) => {
          pointer.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onPointerUp={(event) => {
          const down = pointer.current;
          pointer.current = null;
          if (!down || down.id !== event.pointerId) {
            return;
          }
          if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) {
            setGestureError(
              "capability_missing: iOS swipes, including edge swipes, are unsupported. No input was sent."
            );
            return;
          }
          setGestureError(null);
          if (
            transport !== "live" ||
            !canvas.current ||
            session.controller !== "user"
          ) {
            return;
          }
          const box = event.currentTarget.getBoundingClientRect();
          onPick(
            {
              x: (event.clientX - box.left) / box.width,
              y: (event.clientY - box.top) / box.height,
            },
            { height: canvas.current.height, width: canvas.current.width }
          );
        }}
      />
    </div>
  );
};

const IosSetupSheet = ({
  send,
  pending,
  onClose,
}: {
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly pending: boolean;
  readonly onClose: () => void;
}) => {
  const devices = useAtomValue(iosDevicesAtom);
  const refresh = useAtomRefresh(iosDevicesAtom);
  return (
    <section
      aria-label="New iOS session"
      className="bg-background absolute inset-4 z-20 overflow-auto rounded-xl border p-6"
    >
      <h1>New iOS session</h1>
      <p>
        Unlisted iPhone simulator proof. Each journey restarts the Target App on
        the selected running simulator using its existing data.
      </p>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const device = AsyncResult.isSuccess(devices)
            ? devices.value.find((entry) => entry.udid === text(data, "device"))
            : undefined;
          if (!device || device.state !== "Booted") {
            return;
          }
          const selection: IosWorkspaceSelection = {
            device,
            environment: {
              build: text(data, "build"),
              bundleId: text(data, "bundle"),
              deviceType: device.deviceType,
              runtimeVersion: device.runtimeVersion,
            },
            outcomes: [
              {
                name: text(data, "outcome"),
                role: text(data, "outcomeRole"),
              },
            ],
            setup: {
              conditions: [
                {
                  name: text(data, "starting"),
                  role: text(data, "startingRole"),
                },
              ],
              kind: "restart-app",
            },
          };
          const appPath = text(data, "path");
          send({
            _tag: "start",
            flowSkillName: FlowSkillName.make(text(data, "flow")),
            kind: "teaching",
            operationId: operationId(),
            recordingId: null,
            selection: appPath === "" ? selection : { ...selection, appPath },
          });
        }}
      >
        <label>
          Flow skill name
          <Input name="flow" required />
        </label>
        <label>
          Device
          <select name="device" required>
            {AsyncResult.isSuccess(devices)
              ? devices.value.map((device) => (
                  <option
                    key={device.udid}
                    value={device.udid}
                    disabled={device.state !== "Booted"}
                  >
                    {device.name} · iOS {device.runtimeVersion} ·{" "}
                    {device.state === "Booted"
                      ? "Running"
                      : "Stopped. Start in Simulator, then refresh"}
                  </option>
                ))
              : null}
          </select>
        </label>
        <Button onClick={refresh} type="button" variant="outline">
          Refresh devices
        </Button>
        <label>
          Simulator app path
          <Input name="path" />
          <span>
            Optional. A named build requires a separate installation decision.
          </span>
        </label>
        <label>
          Bundle identifier
          <Input name="bundle" required />
        </label>
        <label>
          App build
          <Input name="build" required />
        </label>
        <label>
          Starting screen role
          <Input name="startingRole" defaultValue="text" required />
        </label>
        <label>
          Starting screen element
          <Input name="starting" required />
        </label>
        <label>
          Done when role
          <Input name="outcomeRole" defaultValue="text" required />
        </label>
        <label>
          Done when element
          <Input name="outcome" required />
        </label>
        <Button disabled={pending} type="submit">
          Open session
        </Button>
        <Button onClick={onClose} type="button" variant="outline">
          Cancel
        </Button>
      </form>
    </section>
  );
};

const IosInput = ({
  session,
  send,
  pending,
}: {
  readonly session: IosWorkspaceSnapshot;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly pending: boolean;
}) => {
  const fields = () => ({ operationId: operationId(), sessionId: session.id });
  return (
    <>
      {session ? (
        <AndroidVariables
          session={session}
          pending={pending}
          onSupply={(name, requestId, value) =>
            send({
              _tag: "variable-supply",
              ...fields(),
              name,
              requestId,
              value,
            })
          }
        />
      ) : null}
      {session?.field ? (
        <form
          aria-label="Field Variable"
          onSubmit={(event) => {
            event.preventDefault();
            const name = text(new FormData(event.currentTarget), "variable");
            send({
              _tag: "variable-request",
              ...fields(),
              name,
              purpose: `Input for ${session.field?.name}`,
              replace: false,
            });
          }}
        >
          <label>
            Variable name
            <Input name="variable" defaultValue="PASSWORD" required />
          </label>
          <Button disabled={pending} type="submit">
            Request Variable
          </Button>
          {(session.variables ?? []).map((variable) =>
            variable.status === "supplied" ? (
              <Button
                key={variable.name}
                disabled={pending}
                type="button"
                onClick={() => {
                  if (session.field) {
                    send({
                      _tag: "input",
                      ...fields(),
                      action: {
                        _tag: "variable",
                        name: variable.name,
                        target: session.field.target,
                      },
                      observationId: session.field.observationId,
                    });
                  }
                }}
              >
                Enter {variable.name}
              </Button>
            ) : null
          )}
        </form>
      ) : null}
      {session?.field ? (
        <form
          aria-label={`Type into ${session.field.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (session.field) {
              send({
                _tag: "input",
                ...fields(),
                action: {
                  _tag: "fill",
                  target: session.field.target,
                  text: text(new FormData(event.currentTarget), "text"),
                },
                observationId: session.field.observationId,
              });
            }
          }}
        >
          <label>
            Text for {session.field.name}
            <Input name="text" required />
          </label>
          <Button disabled={pending} type="submit">
            Type
          </Button>
        </form>
      ) : null}
    </>
  );
};

// Each dock control belongs to one closed native Workspace lifecycle state.
// oxlint-disable-next-line eslint/complexity
const IosDock = ({
  session,
  send,
  gesture,
}: {
  readonly session: IosWorkspaceSnapshot | null;
  readonly send: (command: IosWorkspaceCommand) => boolean;
  readonly gesture: {
    readonly pending: boolean;
    readonly error: string | undefined;
  };
}) => {
  const [commenting, setCommenting] = useState(false);
  const listed = useAtomValue(iosSessionsAtom);
  const sessions = AsyncResult.isSuccess(listed) ? listed.value : [];
  const choices =
    session && !sessions.some((entry) => entry.id === session.id)
      ? [session, ...sessions]
      : sessions;
  const fields = () => ({
    operationId: operationId(),
    sessionId: session?.id ?? AgentSessionId.make("agent-ios-unselected"),
  });
  const recording = session?.captureState?._tag === "recording";
  const live = session?.phase === "running" || session?.phase === "paused";
  return (
    <section
      role="region"
      aria-label="Workspace dock"
      className="bg-background absolute right-4 bottom-4 left-4 mx-auto grid max-w-3xl gap-2 rounded-xl border p-4 shadow-lg"
    >
      <Wordmark />
      <p role="status">
        {session
          ? `${session.flowSkillName} · ${recording ? "Recording" : (session.captureState?._tag ?? session.phase)} · ${session.kind}`
          : "No iOS session"}
      </p>
      {gesture.error ? <p role="alert">{gesture.error}</p> : null}
      {session?.error ? <p role="alert">{session.error}</p> : null}
      {session?.boundary ? <p>{session.boundary.description}</p> : null}
      {session?.preparation.pending.map((decision) => (
        <div
          key={decision.id}
          role="region"
          aria-label={
            {
              "app-installation": "App installation",
              confirmation: "Confirmation",
              "run-environment-permission": "Run Environment Permission",
            }[decision.kind]
          }
        >
          <p>
            {
              {
                "app-installation": `Install build ${session.selection.environment.build} of ${session.selection.environment.bundleId} on the selected simulator?`,
                confirmation: "Allow this action attempt once?",
                "run-environment-permission":
                  "Allow this Run to use the selected environment?",
              }[decision.kind]
            }
          </p>
          <Button
            disabled={gesture.pending}
            onClick={() =>
              send({
                _tag: "decide",
                ...fields(),
                allow: true,
                decisionId: decision.id,
              })
            }
          >
            Allow
          </Button>
          <Button
            disabled={gesture.pending}
            onClick={() =>
              send({
                _tag: "decide",
                ...fields(),
                allow: false,
                decisionId: decision.id,
              })
            }
          >
            Refuse
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <label>
          iOS Agent Session
          <select
            value={session?.id ?? ""}
            onChange={(event) =>
              globalThis.location.assign(
                `/?ios=${event.currentTarget.value || "new"}`
              )
            }
          >
            <option value="">New iOS session</option>
            {choices.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.flowSkillName} · {entry.kind}
              </option>
            ))}
          </select>
        </label>
        <Button
          onClick={() => globalThis.location.assign("/")}
          variant="outline"
        >
          Browser Workspace
        </Button>
        {session?.phase === "pending" ? (
          <Button
            disabled={gesture.pending || session.preparation.pending.length > 0}
            onClick={() => send({ _tag: "prepare", ...fields() })}
          >
            Prepare selected simulator
          </Button>
        ) : null}
        {session?.phase === "paused" ? (
          <Button
            disabled={gesture.pending}
            onClick={() =>
              send({
                _tag: session.refusal?.recovery ?? "recover",
                ...fields(),
              })
            }
          >
            {session.refusal
              ? "Return to Target App"
              : "Recover selected simulator"}
          </Button>
        ) : null}
        {session?.phase === "running" &&
        session.kind === "teaching" &&
        session.controller === "user" &&
        (recording || session.captureState?._tag === "setup") ? (
          <>
            <Button
              disabled={gesture.pending}
              onClick={() =>
                send({ _tag: "record", ...fields(), start: !recording })
              }
            >
              {recording ? "Stop recording" : "Start recording"}
            </Button>
            {recording ? (
              <Button onClick={() => setCommenting(true)} variant="outline">
                Comment
              </Button>
            ) : null}
          </>
        ) : null}
        {live && session.kind !== "teaching" ? (
          <Button
            disabled={gesture.pending}
            onClick={() =>
              send({
                _tag: "control",
                ...fields(),
                controller: session.controller === "user" ? "agent" : "user",
              })
            }
          >
            {session.controller === "user" ? "Return control" : "Take control"}
          </Button>
        ) : null}
        {session &&
        !["closed", "completed", "refused"].includes(session.phase) ? (
          <Button
            disabled={gesture.pending}
            onClick={() => send({ _tag: "close", ...fields() })}
            variant="outline"
          >
            Close session
          </Button>
        ) : null}
        {session?.captureState?._tag === "dry-run-passed" ? (
          <>
            <Button
              disabled={gesture.pending}
              onClick={() =>
                send({ _tag: "flow-decision", ...fields(), decision: "verify" })
              }
            >
              Verify flow
            </Button>
            <Button
              disabled={gesture.pending}
              onClick={() =>
                send({ _tag: "flow-decision", ...fields(), decision: "reject" })
              }
              variant="outline"
            >
              Reject flow
            </Button>
          </>
        ) : null}
        {session?.cleanup?._tag === "purge-pending" ? (
          <Button
            disabled={gesture.pending}
            onClick={() =>
              send({
                _tag: "flow-decision",
                ...fields(),
                decision: "retry-cleanup",
              })
            }
            variant="outline"
          >
            Retry cleanup
          </Button>
        ) : null}
      </div>
      {session?.cleanup?._tag === "purge-pending" ? (
        <p className="text-destructive text-pretty" role="alert">
          {session.cleanup.failure} Kept:{" "}
          {session.cleanup.retainedFiles.join(", ")}.
        </p>
      ) : null}
      {session?.cleanup?._tag === "purged" ? (
        <p className="text-muted-foreground text-pretty">
          Recording deleted. Verified Flow Skill retained.
        </p>
      ) : null}
      {session ? (
        <IosInput session={session} send={send} pending={gesture.pending} />
      ) : null}
      {commenting && recording ? (
        <form
          aria-label="Comment"
          onSubmit={(event) => {
            event.preventDefault();
            send({
              _tag: "instruction",
              ...fields(),
              text: text(new FormData(event.currentTarget), "instruction"),
            });
            setCommenting(false);
          }}
        >
          <label>
            Instruction
            <Input name="instruction" required />
          </label>
          <Button type="submit">Add</Button>
        </form>
      ) : null}
      {session?.assessment ? (
        <aside aria-label="Run Summary">
          <p>{session.assessment.outcome}</p>
          <p>{session.assessment.explanation}</p>
        </aside>
      ) : null}
    </section>
  );
};

export const IosWorkspace = ({
  requestedSessionId,
}: {
  readonly requestedSessionId: string;
}) => {
  const [session, setSession] = useAtom(snapshotAtom);
  const setChrome = useAtomSet(workspaceChromeAtom);
  useEffect(() => {
    setChrome(true);
    return () => setChrome(false);
  }, [setChrome]);
  const enabled = useAtomValue(iosEnabledAtom);
  const gesture = useWorkspaceGesture(commandAtom);
  const [sheet, setSheet] = useState(requestedSessionId === "new");
  const apply = (next: IosWorkspaceSnapshot) =>
    setSession((current) =>
      current?.id === next.id && current.revision > next.revision
        ? current
        : next
    );
  const send = (command: IosWorkspaceCommand) =>
    gesture.dispatch(
      runIosWorkspaceCommand(command).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            apply(next);
            if (command._tag === "start") {
              setSheet(false);
            }
          })
        ),
        Effect.asVoid,
        Effect.mapError(errorMessage)
      )
    );
  useEffect(() => {
    if (!Schema.is(AgentSessionId)(requestedSessionId)) {
      return;
    }
    const fiber = Effect.runFork(
      runIosWorkspaceCommand({
        _tag: "read",
        sessionId: requestedSessionId,
      }).pipe(
        Effect.tap((next) => Effect.sync(() => setSession(next))),
        Effect.ignore
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestedSessionId, setSession]);
  const id = session?.id;
  useEffect(() => {
    if (!id) {
      return;
    }
    const fiber = Effect.runFork(
      Effect.forever(
        runIosWorkspaceCommand({ _tag: "read", sessionId: id }).pipe(
          Effect.tap((next) =>
            Effect.sync(() =>
              setSession((current) =>
                current?.id === id && current.revision <= next.revision
                  ? next
                  : current
              )
            )
          ),
          Effect.ignore,
          Effect.andThen(Effect.sleep("1 second"))
        )
      )
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id, setSession]);
  if (!AsyncResult.isSuccess(enabled) || !enabled.value) {
    return <p>iOS Workspace is unlisted.</p>;
  }
  const fields = () => ({
    operationId: operationId(),
    sessionId: session?.id ?? AgentSessionId.make("agent-ios-unselected"),
  });
  return (
    <main
      className="relative flex h-full min-h-0 flex-col"
      aria-label="iOS Workspace"
      aria-busy={gesture.pending}
    >
      {session ? (
        <IosMirror
          session={session}
          onPick={(point, frame) => {
            if (session.observation) {
              send({
                _tag: "pick",
                ...fields(),
                frame,
                observationId: session.observation.id,
                point,
              });
            }
          }}
        />
      ) : (
        <div className="grid flex-1 place-content-center">
          <Button onClick={() => setSheet(true)}>Open iOS session</Button>
        </div>
      )}
      {sheet ? (
        <IosSetupSheet
          send={send}
          pending={gesture.pending}
          onClose={() => setSheet(false)}
        />
      ) : null}
      <IosDock session={session} send={send} gesture={gesture} />
    </main>
  );
};
