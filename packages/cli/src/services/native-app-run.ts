import { randomUUID } from "node:crypto";

import { Effect, Scope, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { nativeAppRuntimeError } from "./native-app-error.ts";
import type {
  NativeAppRun,
  NativeAppRunInput,
  NativeAppRunDecision,
  NativeAppRunDriver,
  NativeAppRunEvidence,
  NativeAppRunState,
} from "./native-app-run-contract.ts";
import type { NativeAppRuntime } from "./native-app-runtime-contract.ts";
import type {
  PlatformObservation,
  PlatformRuntimeError,
} from "./platform-runtime.ts";

export const createNativeAppRun = <
  Input extends NativeAppRunInput,
  Observation extends PlatformObservation,
  Decision extends NativeAppRunDecision,
>(
  request: Input,
  driver: NativeAppRunDriver<Input, Observation, Decision>
): Effect.Effect<
  NativeAppRun<Observation, NativeAppRunState<Input, Decision>>,
  PlatformRuntimeError
> =>
  Effect.gen(function* createRun() {
    const makeError = driver.error ?? nativeAppRuntimeError;
    // Copy caller-owned declarations before retaining any authority.
    const { scope: _scope, ...declarations } = request;
    const startup = { ...request, ...structuredClone(declarations) };
    yield* driver.validate(startup);
    yield* driver.preflight(startup);
    const differences = driver.differences(startup);
    const runId = randomUUID();
    const registry = AtomRegistry.make();
    const initialDecisions = driver.decisions(startup, runId, differences);
    const status = Atom.make<NativeAppRunState<Input, Decision>>({
      decisions: initialDecisions,
      device: startup.device,
      differences,
      environment: startup.environment,
      evidence: [{ type: "preflight" }],
      pending: initialDecisions,
      phase: "pending",
      runId,
      setup: startup.setup,
      taught: startup.taught,
    }).pipe(Atom.keepAlive);
    registry.get(status);
    const latest = Atom.make<Observation | null>(null).pipe(Atom.keepAlive);
    registry.get(latest);
    const lock = Semaphore.makeUnsafe(1);
    let runtime: NativeAppRuntime<Observation> | undefined;
    const prepared = Atom.make(false).pipe(Atom.keepAlive);
    registry.get(prepared);
    let terminal: NativeAppRunState<Input, Decision> | undefined;
    const currentState = () => terminal ?? registry.get(status);
    const state = () => structuredClone(currentState());
    const record = (event: NativeAppRunEvidence) =>
      registry.update(status, (current) => ({
        ...current,
        evidence: [...current.evidence, event],
      }));
    const paused = (error: PlatformRuntimeError) =>
      Effect.sync(() => {
        if (
          terminal !== undefined ||
          currentState().phase === "refused" ||
          (error.code === "preparation_required" && runtime === undefined)
        ) {
          return;
        }
        registry.set(latest, null);
        record({ code: error.code, type: "pause" });
        registry.update(status, (current) => ({
          ...current,
          phase: "paused" as const,
        }));
      });
    const guarded = <A>(effect: Effect.Effect<A, PlatformRuntimeError>) =>
      effect.pipe(
        Effect.tapError(paused),
        Effect.onInterrupt(() => paused(makeError("execution_canceled")))
      );
    const observed = (observation: Observation, retainEvidence = true) =>
      Effect.sync(() => {
        registry.set(latest, structuredClone(observation));
        if (retainEvidence) {
          record({ observationId: observation.id, type: "observation" });
        }
        registry.update(status, (current) => ({
          ...current,
          phase: "ready" as const,
        }));
        return structuredClone(observation);
      });
    const requireRuntime = () =>
      Effect.suspend(() =>
        runtime !== undefined && currentState().phase === "ready"
          ? Effect.succeed(runtime)
          : Effect.fail(makeError("preparation_required"))
      );
    const close = lock.withPermits(1)(
      Effect.gen(function* closeRun() {
        if (terminal !== undefined) {
          return;
        }
        if (runtime !== undefined) {
          yield* runtime.close();
          const { failure } = runtime.state();
          if (failure !== null) {
            record({ code: failure.code, type: "pause" });
          }
        }
        record({ type: "closed" });
        terminal = { ...registry.get(status), pending: [], phase: "closed" };
        registry.dispose();
      })
    );
    yield* Scope.addFinalizer(startup.scope, close);
    return {
      back: (id) =>
        lock.withPermits(1)(
          guarded(
            requireRuntime().pipe(Effect.flatMap((active) => active.back(id)))
          )
        ),
      close: () => close,
      decide: (id, allow) =>
        lock.withPermits(1)(
          Effect.gen(function* decide() {
            const current = currentState();
            const decision = current.pending.find(
              (candidate) => candidate.id === id
            );
            if (
              terminal !== undefined ||
              current.phase !== "pending" ||
              decision === undefined
            ) {
              return yield* Effect.fail(makeError("permission_stale"));
            }
            record({ decisionId: id, type: allow ? "grant" : "refusal" });
            registry.update(status, (value) => ({
              ...value,
              pending: allow
                ? value.pending.filter((candidate) => candidate.id !== id)
                : [],
              phase: allow ? ("pending" as const) : ("refused" as const),
            }));
          })
        ),
      dispatch: (id, action) =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* dispatch() {
              const active = yield* requireRuntime();
              const observation = registry.get(latest);
              registry.set(latest, null);
              if (action.type === "activate") {
                const node = observation?.nodes.find(
                  (candidate) => candidate.target === action.target
                );
                if (
                  node === undefined ||
                  (!startup.teaching &&
                    !startup.reversibleActions?.some(
                      (allowed) =>
                        allowed.role === node.role && allowed.name === node.name
                    ))
                ) {
                  yield* active.invalidate();
                  return yield* Effect.fail(makeError("target_unsupported"));
                }
              }
              yield* active.dispatch(id, action);
            })
          )
        ),
      enterPrivate: (id, privateRequest) =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* enterPrivate() {
              const active = yield* requireRuntime();
              registry.set(latest, null);
              return yield* active.enterPrivate(id, privateRequest);
            })
          )
        ),
      mirror: () =>
        lock.withPermits(1)(
          guarded(
            requireRuntime().pipe(
              Effect.flatMap((active) => active.observe()),
              Effect.flatMap((observation) => observed(observation, false))
            )
          )
        ),
      observe: () =>
        lock.withPermits(1)(
          guarded(
            requireRuntime().pipe(
              Effect.flatMap((active) => active.observe()),
              Effect.flatMap((observation) => observed(observation))
            )
          )
        ),
      prepare: () =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* prepare() {
              if (
                currentState().phase !== "pending" ||
                currentState().pending.length !== 0 ||
                runtime !== undefined
              ) {
                return yield* Effect.fail(makeError("preparation_required"));
              }
              // Recheck immediately before setup. A grant cannot waive a changed selected build.
              yield* driver.preflight(startup);
              runtime = yield* driver.start(driver.authorize(startup));
              record({ type: "setup" });
              const observation = yield* runtime.observe();
              if (!driver.startingConditions(startup, observation)) {
                yield* runtime.close();
                return yield* Effect.fail(
                  makeError("starting_condition_failed")
                );
              }
              registry.set(prepared, true);
              return yield* observed(observation);
            })
          )
        ),
      recover: () =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* recover() {
              if (
                terminal !== undefined ||
                !registry.get(prepared) ||
                runtime === undefined ||
                runtime.state().phase === "closed" ||
                currentState().phase !== "paused"
              ) {
                return yield* Effect.fail(makeError("preparation_required"));
              }
              yield* driver.preflight(startup, "installed");
              return yield* observed(yield* runtime.recover());
            })
          )
        ),
      state,
    };
  });
