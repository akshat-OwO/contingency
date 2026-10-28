import { randomUUID } from "node:crypto";

import { androidPermissionDecisionApi } from "@contingency/protocol";
import { Effect, Scope, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type {
  AndroidEnvironmentDifference,
  AndroidRun,
  AndroidRunDriver,
  AndroidRunEvidence,
  AndroidRunInput,
  AndroidRunState,
} from "./android-run-contract.ts";
import type {
  AndroidObservation,
  AndroidPlatformRuntime,
} from "./android-runtime-contract.ts";
import { validateAndroidStartup } from "./android-startup.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const fields = [
  "androidVersion",
  "appBuild",
  "appId",
  "startingState",
  "permissions",
] as const;
const activityPattern = /^[A-Za-z][A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u;
const permissionPattern = /^android\.permission\.[A-Z_]+$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

const validPermissions = (input: AndroidRunInput) => {
  const permissions = input.environment.permissions ?? [];
  return (
    permissions.every(
      (entry) =>
        permissionPattern.test(entry.permission) &&
        ["grant", "revoke"].includes(entry.decision)
    ) &&
    new Set(permissions.map((entry) => entry.permission)).size ===
      permissions.length
  );
};

export const validateAndroidRun = (input: AndroidRunInput) =>
  Effect.gen(function* validateRun() {
    yield* validateAndroidStartup(input);
    if (
      (input.environment.permissions ?? []).length > 0 &&
      input.device.api < androidPermissionDecisionApi
    ) {
      return yield* Effect.fail(
        platformRuntimeError("permission_decisions_unsupported")
      );
    }
    const required = new Set(input.requiredCapabilities);
    if (
      input.taught.platform !== "android" ||
      input.taught.capabilities.some((capability) => !required.has(capability))
    ) {
      return yield* Effect.fail(platformRuntimeError("capability_missing"));
    }
    if (
      !input.environment.androidVersion ||
      input.environment.appId !== input.targetApp ||
      !input.environment.appBuild ||
      !input.environment.startingState ||
      (input.device.kind === "physical"
        ? input.setup.kind !== "clear-app-data"
        : input.setup.kind !== "restart-activity") ||
      !validPermissions(input) ||
      !activityPattern.test(input.setup.activity) ||
      input.setup.activity.split("/")[0] !== input.targetApp ||
      input.setup.conditions.length === 0 ||
      input.setup.conditions.some(
        (condition) => !condition.role || !condition.name
      ) ||
      (input.appInstallation !== undefined &&
        (!hashPattern.test(input.appInstallation.sha256) ||
          !input.appInstallation.apk))
    ) {
      return yield* Effect.fail(platformRuntimeError("preparation_failed"));
    }
  });

export const createAndroidRun = (
  request: AndroidRunInput,
  driver: AndroidRunDriver
): Effect.Effect<AndroidRun, PlatformRuntimeError> =>
  Effect.gen(function* createRun() {
    // Copy caller-owned declarations before retaining any authority.
    const input = structuredClone({ ...request, scope: undefined });
    const startup: AndroidRunInput = { ...input, scope: request.scope };
    yield* validateAndroidRun(startup);
    yield* driver.preflight(startup);
    const { taught } = startup;
    if (taught.platform !== "android") {
      return yield* Effect.fail(platformRuntimeError("capability_missing"));
    }
    const differences: AndroidEnvironmentDifference[] = fields.flatMap(
      (field) =>
        JSON.stringify(taught.environment[field] ?? []) ===
        JSON.stringify(startup.environment[field] ?? [])
          ? []
          : [
              {
                field,
                selected:
                  field === "permissions"
                    ? JSON.stringify(startup.environment[field] ?? [])
                    : String(startup.environment[field]),
                taught:
                  field === "permissions"
                    ? JSON.stringify(taught.environment[field] ?? [])
                    : String(taught.environment[field]),
              },
            ]
    );
    const runId = randomUUID();
    const registry = AtomRegistry.make();
    const initialDecisions = [
      ...(startup.device.kind === "physical"
        ? [
            {
              differences: [],
              id: randomUUID(),
              kind: "clear-app-data" as const,
              runId,
              serial: startup.device.serial,
              targetApp: startup.targetApp,
            },
          ]
        : []),
      ...(differences.some((difference) => difference.field !== "startingState")
        ? [
            {
              differences,
              id: randomUUID(),
              kind: "run-environment-permission" as const,
              runId,
              targetApp: startup.targetApp,
            },
          ]
        : []),
      ...(startup.appInstallation === undefined
        ? []
        : [
            {
              differences: [],
              id: randomUUID(),
              kind: "app-installation" as const,
              runId,
              sha256: startup.appInstallation.sha256,
              targetApp: startup.targetApp,
            },
          ]),
    ];
    const status = Atom.make<AndroidRunState>({
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
    const latest = Atom.make<AndroidObservation | null>(null).pipe(
      Atom.keepAlive
    );
    registry.get(latest);
    const lock = Semaphore.makeUnsafe(1);
    let runtime: AndroidPlatformRuntime | undefined;
    const prepared = Atom.make(false).pipe(Atom.keepAlive);
    registry.get(prepared);
    let terminal: AndroidRunState | undefined;
    const currentState = () => terminal ?? registry.get(status);
    const state = () => structuredClone(currentState());
    const record = (event: AndroidRunEvidence) =>
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
        Effect.onInterrupt(() =>
          paused(platformRuntimeError("execution_canceled"))
        )
      );
    const observed = (observation: AndroidObservation, retainEvidence = true) =>
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
          : Effect.fail(platformRuntimeError("preparation_required"))
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
              return yield* Effect.fail(
                platformRuntimeError("permission_stale")
              );
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
                  return yield* Effect.fail(
                    platformRuntimeError("target_unsupported")
                  );
                }
              }
              const result = yield* active.dispatch(id, action);
              if (result) {
                record({
                  inputConfirmation: result.confirmation,
                  observationId: id,
                  type: "fill",
                });
              }
              return result;
            })
          )
        ),
      enterVariable: (id, variableRequest) =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* fillVariable() {
              const active = yield* requireRuntime();
              registry.set(latest, null);
              const result = yield* active.enterVariable(id, variableRequest);
              record({
                inputConfirmation: result.confirmation,
                observationId: id,
                type: "fill",
              });
              return result;
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
                return yield* Effect.fail(
                  platformRuntimeError("preparation_required")
                );
              }
              // Recheck immediately before setup. A grant cannot waive a changed selected build.
              yield* driver.preflight(startup);
              let authorized = startup;
              if (startup.device.kind === "physical") {
                authorized = {
                  ...startup,
                  clearDataGrant: {
                    serial: startup.device.serial,
                    targetApp: startup.targetApp,
                  },
                };
              }
              runtime = yield* driver.start(authorized);
              record({ type: "setup" });
              const observation = yield* runtime.observe();
              if (
                !startup.setup.conditions.every((condition) =>
                  observation.nodes.some(
                    (node) =>
                      node.packageName === startup.targetApp &&
                      !node.covered &&
                      !node.password &&
                      node.role === condition.role &&
                      node.name === condition.name
                  )
                )
              ) {
                yield* runtime.close();
                return yield* Effect.fail(
                  platformRuntimeError("starting_condition_failed")
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
                return yield* Effect.fail(
                  platformRuntimeError("preparation_required")
                );
              }
              yield* driver.preflight(startup, "installed");
              return yield* observed(yield* runtime.recover());
            })
          )
        ),
      state,
    };
  });
