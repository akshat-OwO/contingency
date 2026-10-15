import { randomUUID } from "node:crypto";

import { Effect, Schema, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

export class ProbeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
  }
}

const envelope = Schema.Struct({
  error: Schema.optional(Schema.String),
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  session: Schema.String,
  version: Schema.Number,
});
const hello = Schema.Struct({
  api: Schema.Number,
  capabilities: Schema.Array(Schema.String),
  target: Schema.String,
});
export const observationSchema = Schema.Struct({
  height: Schema.Number,
  nodes: Schema.Array(
    Schema.Struct({
      bounds: Schema.Array(Schema.Number),
      clickable: Schema.Boolean,
      editable: Schema.Boolean,
      enabled: Schema.Boolean,
      role: Schema.String,
      target: Schema.String,
    })
  ),
  observation: Schema.String,
  package: Schema.String,
  screenshot: Schema.String,
  width: Schema.Number,
});
export type Observation = typeof observationSchema.Type;
export type Action =
  | { readonly kind: "click"; readonly target: string }
  | {
      readonly kind: "fill";
      readonly target: string;
      readonly variable: string;
    }
  | { readonly kind: "coordinate"; readonly x: number; readonly y: number };
export interface Request {
  readonly id: string;
  readonly session: string;
  readonly version: number;
  readonly op:
    | "hello"
    | "observe"
    | "action"
    | "close"
    | "invalidate"
    | "launch"
    | "fault_capture";
  readonly observation?: string;
  readonly kind?: "click" | "fill" | "coordinate";
  readonly target?: string;
  readonly variable?: string;
  readonly value?: string;
  readonly x?: number;
  readonly y?: number;
}
export type Transport = (
  request: Request
) => Effect.Effect<unknown, ProbeError>;

/** Prototype protocol client. No production runtime or Workspace registration. */
export const makeDriver = (input: {
  readonly serial: string;
  readonly target: string;
  readonly transport: Transport;
  readonly secret: (variable: string) => Effect.Effect<string, ProbeError>;
}) => {
  const atoms = AtomRegistry.make();
  const state = Atom.make<{
    readonly capabilities: readonly string[];
    readonly closed: boolean;
    readonly observation: string;
    readonly paused: boolean;
    readonly session: string;
  }>({
    capabilities: [],
    closed: false,
    observation: "",
    paused: true,
    session: "",
  }).pipe(Atom.keepAlive);
  atoms.get(state);
  const lock = Semaphore.makeUnsafe(1);
  const pause = Effect.sync(() => {
    atoms.update(state, (current) => ({
      ...current,
      observation: "",
      paused: true,
    }));
  });
  const call = (
    op: Request["op"],
    args: Omit<Partial<Request>, "op" | "id" | "session" | "version"> = {}
  ) =>
    Effect.gen(function* request() {
      if (atoms.get(state).closed) {
        return yield* Effect.fail(new ProbeError("closed"));
      }
      const id = randomUUID();
      const raw = yield* input.transport({
        ...args,
        id,
        op,
        session: atoms.get(state).session,
        version: 1,
      });
      const response = yield* Effect.try({
        catch: () => new ProbeError("protocol_invalid"),
        try: () => Schema.decodeUnknownSync(envelope)(raw),
      });
      if (response.id !== id || response.version !== 1 || !response.session) {
        return yield* Effect.fail(new ProbeError("protocol_incompatible"));
      }
      if (op !== "hello" && response.session !== atoms.get(state).session) {
        return yield* Effect.fail(new ProbeError("session_stale"));
      }
      if (response.error !== undefined) {
        return yield* Effect.fail(new ProbeError(response.error));
      }
      return response;
    }).pipe(Effect.onError(() => pause));
  const connect = lock.withPermits(1)(
    Effect.gen(function* connectDriver() {
      yield* pause;
      const response = yield* call("hello");
      const result = yield* Effect.try({
        catch: () => new ProbeError("protocol_invalid"),
        try: () => Schema.decodeUnknownSync(hello)(response.result),
      });
      if (result.api < 30 || result.target !== input.target) {
        return yield* Effect.fail(new ProbeError("environment_incompatible"));
      }
      for (const capability of [
        "semantic",
        "screenshot",
        "coordinate",
        "private-input",
      ]) {
        if (!result.capabilities.includes(capability)) {
          return yield* Effect.fail(new ProbeError("capability_missing"));
        }
      }
      atoms.update(state, (current) => ({
        ...current,
        capabilities: result.capabilities,
        session: response.session,
      }));
      return result;
    })
  );
  const observe = lock.withPermits(1)(
    Effect.gen(function* observeDriver() {
      yield* pause;
      const response = yield* call("observe");
      const result = yield* Effect.try({
        catch: () => new ProbeError("capture_invalid"),
        try: () => Schema.decodeUnknownSync(observationSchema)(response.result),
      });
      if (
        result.package !== input.target ||
        !result.observation ||
        !result.screenshot
      ) {
        return yield* Effect.fail(new ProbeError("capture_invalid"));
      }
      atoms.update(state, (current) => ({
        ...current,
        observation: result.observation,
        paused: false,
      }));
      return result;
    }).pipe(Effect.onError(() => pause))
  );
  const dispatch = (id: string, action: Action) =>
    lock.withPermits(1)(
      Effect.gen(function* dispatchDriver() {
        const current = atoms.get(state);
        if (current.closed || current.paused || current.observation !== id) {
          return yield* Effect.fail(new ProbeError("observation_stale"));
        }
        // Consume before resolving private input or sending any bytes. Never replay.
        yield* pause;
        const value =
          action.kind === "fill"
            ? yield* input.secret(action.variable)
            : undefined;
        const payload = { ...action, observation: id };
        const { result } = yield* call(
          "action",
          value === undefined ? payload : { ...payload, value }
        );
        const outcome = yield* Effect.try({
          catch: () => new ProbeError("protocol_invalid"),
          try: () =>
            Schema.decodeUnknownSync(
              Schema.Struct({ dispatched: Schema.Boolean })
            )(result),
        });
        if (!outcome.dispatched) {
          return yield* Effect.fail(new ProbeError("input_failed"));
        }
        // This action record contains only the Variable reference.
        return {
          action,
          observation: id,
          serial: input.serial,
          session: current.session,
        };
      })
    );
  const close = lock.withPermits(1)(
    Effect.gen(function* closeDriver() {
      if (atoms.get(state).closed) {
        return;
      }
      yield* pause;
      yield* call("close").pipe(
        Effect.ensuring(
          Effect.sync(() =>
            atoms.update(state, (current) => ({ ...current, closed: true }))
          )
        )
      );
    })
  );
  const launch = (target: string) =>
    lock.withPermits(1)(
      Effect.gen(function* launchApp() {
        yield* pause;
        if (target !== input.target) {
          return yield* Effect.fail(new ProbeError("launch_unauthorized"));
        }
        yield* call("launch", { target });
      })
    );
  return {
    close,
    connect,
    dispatch,
    failNextCapture: lock.withPermits(1)(
      Effect.gen(function* failCapture() {
        yield* pause;
        if (!atoms.get(state).capabilities.includes("fault-injection")) {
          return yield* Effect.fail(new ProbeError("capability_missing"));
        }
        yield* call("fault_capture");
      })
    ),
    invalidate: lock.withPermits(1)(pause),
    launch,
    observe,
    status: Effect.sync(() => atoms.get(state)),
  };
};
