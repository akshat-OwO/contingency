import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Redacted, Scope } from "effect";

import type {
  AndroidObservation,
  AndroidRuntimeBackend,
  AndroidRuntimeStartInput,
} from "../../src/services/android-runtime-contract.ts";
import {
  adaptAndroidRuntime,
  makeAndroidRuntimeFactory,
} from "../../src/services/android-runtime.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import { makePlatformRuntimeFactory } from "../../src/services/platform-runtime.ts";

const startup = (scope: Scope.Scope): AndroidRuntimeStartInput => ({
  device: {
    api: 36,
    avd: "selected-avd",
    fingerprint: "selected-build",
    host: "local",
    serial: "selected-serial",
  },
  platform: "android",
  requiredCapabilities: ["semantic-actions", "screenshots"],
  scope,
  targetApp: "dev.fixture",
});

const captured = (id: string): AndroidObservation => ({
  backendSessionId: "owned-session",
  capture: {
    complete: true,
    mode: "interactive-windows",
    secureWindowVisibility: "unverified",
    windowCount: 1,
  },
  device: startup(Scope.makeUnsafe()).device,
  generation: 1,
  id,
  nodes: [
    {
      covered: false,
      editable: false,
      hittable: true,
      name: "Open",
      packageName: "dev.fixture",
      password: false,
      role: "button",
      target: "@e1~s1",
    },
    {
      covered: false,
      editable: true,
      hittable: true,
      name: "Public input",
      packageName: "dev.fixture",
      password: false,
      role: "textbox",
      target: "@e2~s1",
    },
    {
      covered: false,
      editable: true,
      hittable: true,
      name: "Private field",
      packageName: "dev.fixture",
      password: true,
      role: "textbox",
      target: "@e3~s1",
    },
    {
      covered: true,
      editable: false,
      hittable: true,
      name: "Covered",
      packageName: "dev.fixture",
      password: false,
      role: "button",
      target: "@e4~s1",
    },
  ],
  ownership: {
    focusedPackage: "dev.fixture",
    kind: "experimental-host-check",
    systemDialogAuthority: "unsupported",
  },
  platform: "android",
  screenshot: {
    capturedAt: "2026-10-13",
    encoding: "base64",
    format: "png",
    image: "pixels",
  },
});

const makeFixture = (
  requiredCapabilities: AndroidRuntimeStartInput["requiredCapabilities"] = [
    "semantic-actions",
    "screenshots",
  ]
) =>
  Effect.gen(function* fixture() {
    const commands: string[] = [];
    let generation = 0;
    const backend: AndroidRuntimeBackend = {
      activate: () =>
        Effect.sync(() => {
          commands.push("activate");
        }),
      back: () =>
        Effect.sync(() => {
          commands.push("back");
        }),
      capture: () =>
        Effect.sync(() => {
          generation += 1;
          return captured(`observation-${generation}`);
        }),
      close: () =>
        Effect.sync(() => {
          commands.push("close");
        }),
      enterPrivate: (target, value) =>
        Effect.gen(function* enterPrivate() {
          const resolved = yield* value;
          commands.push(
            Redacted.isRedacted(resolved) ? `private:${target}` : "exposed"
          );
        }),
      fill: (_target, text) =>
        Effect.sync(() => {
          commands.push(`public:${text}`);
        }),
      recover: () => Effect.void,
      sessionId: "owned-session",
      validate: () => Effect.void,
    };
    const input = { ...startup(yield* Scope.Scope), requiredCapabilities };
    const runtime = yield* adaptAndroidRuntime({ backend, startup: input });
    return { backend, commands, input, runtime };
  });

it.effect(
  "blocks deferred capabilities and implicit device selection before acquisition",
  () =>
    Effect.gen(function* startupRefusals() {
      const factory = makeAndroidRuntimeFactory();
      const input = startup(yield* Scope.Scope);
      for (const capability of [
        "coordinate-actions",
        "teaching-capture",
        "emulation",
      ] as const) {
        expect(
          (yield* Effect.flip(
            factory.start({ ...input, requiredCapabilities: [capability] })
          )).code
        ).toBe("capability_missing");
      }
      expect(
        (yield* Effect.flip(
          factory.start({ ...input, device: { ...input.device, serial: "" } })
        )).code
      ).toBe("device_selection_required");
    })
);

it.effect(
  "consumes an observation once and requires evidence after dispatch",
  () =>
    Effect.gen(function* consumeObservation() {
      const { commands, runtime } = yield* makeFixture();
      const before = yield* runtime.observe();
      yield* runtime.dispatch(before.id, {
        target: "@e1~s1",
        type: "activate",
      });
      expect(runtime.state()).toMatchObject({
        observationId: null,
        outcome: "uncertain",
        phase: "ready",
      });
      expect(
        (yield* Effect.flip(
          runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
        )).code
      ).toBe("observation_stale");
      expect(commands).toEqual(["activate"]);
      expect(runtime.state().phase).toBe("paused");
      const fresh = yield* runtime.recover();
      expect(fresh.id).not.toBe(before.id);
      expect(runtime.state()).toMatchObject({
        observationId: fresh.id,
        outcome: "observed",
        phase: "ready",
      });
    })
);

it.effect(
  "refuses coordinates, arbitrary keys, private and covered fields before backend input",
  () =>
    Effect.gen(function* actionRefusals() {
      const { commands, runtime } = yield* makeFixture();
      const attempts = [
        { type: "coordinate" as const, x: 1, y: 1 },
        { key: "Enter", target: "@e1~s1", type: "press" as const },
        { target: "@e3~s1", text: "never-dispatched", type: "fill" as const },
        { target: "@e4~s1", type: "activate" as const },
        { target: "missing", type: "activate" as const },
      ];
      for (const action of attempts) {
        const observation = yield* runtime.recover();
        yield* Effect.flip(runtime.dispatch(observation.id, action));
        expect(runtime.state().observationId).toBeNull();
      }
      expect(commands).toEqual([]);
    })
);

it.effect("permits public text and Back only through a fresh observation", () =>
  Effect.gen(function* supportedActions() {
    const { commands, runtime } = yield* makeFixture();
    const first = yield* runtime.observe();
    yield* runtime.dispatch(first.id, {
      target: "@e2~s1",
      text: "ordinary fixture value",
      type: "fill",
    });
    const second = yield* runtime.observe();
    yield* runtime.back(second.id);
    expect(commands).toEqual(["public:ordinary fixture value", "back"]);
  })
);

it.effect(
  "invalidates capture failures and revalidates the selected identity on recovery",
  () =>
    Effect.gen(function* failedCapture() {
      const { backend, input } = yield* makeFixture();
      let valid = true;
      const runtime = yield* adaptAndroidRuntime({
        backend: {
          ...backend,
          validate: () =>
            valid
              ? Effect.void
              : Effect.fail(platformRuntimeError("device_mismatch")),
        },
        startup: input,
      });
      const before = yield* runtime.observe();
      valid = false;
      expect((yield* Effect.flip(runtime.observe())).code).toBe(
        "device_mismatch"
      );
      expect(runtime.state()).toMatchObject({
        observationId: null,
        phase: "paused",
      });
      expect((yield* Effect.flip(runtime.recover())).code).toBe(
        "device_mismatch"
      );
      valid = true;
      expect((yield* runtime.recover()).id).not.toBe(before.id);
    })
);

it.effect("pauses on unknown ownership without dispatch", () =>
  Effect.gen(function* refuseOwnership() {
    const { backend, commands, input } = yield* makeFixture();
    let owned = true;
    const runtime = yield* adaptAndroidRuntime({
      backend: {
        ...backend,
        validate: () =>
          owned
            ? Effect.void
            : Effect.fail(platformRuntimeError("ownership_unknown")),
      },
      startup: input,
    });
    const before = yield* runtime.observe();
    owned = false;
    expect(
      (yield* Effect.flip(
        runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
      )).code
    ).toBe("ownership_unknown");
    expect(commands).toEqual([]);
    expect(runtime.state().outcome).toBe("observed");
  })
);

it.effect("does not replay a failed dispatched action", () =>
  Effect.gen(function* uncertainDispatch() {
    const { backend, commands, input } = yield* makeFixture();
    const runtime = yield* adaptAndroidRuntime({
      backend: {
        ...backend,
        activate: () =>
          Effect.sync(() => {
            commands.push("dispatched");
          }).pipe(
            Effect.andThen(Effect.fail(platformRuntimeError("runtime_failed")))
          ),
      },
      startup: input,
    });
    const before = yield* runtime.observe();
    yield* Effect.flip(
      runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
    );
    expect(runtime.state()).toMatchObject({
      observationId: null,
      outcome: "uncertain",
      phase: "paused",
    });
    yield* runtime.recover();
    expect(commands).toEqual(["dispatched"]);
  })
);

it.effect(
  "cancellation clears observations and preserves uncertain dispatch",
  () =>
    Effect.gen(function* cancelDispatch() {
      const { backend, input } = yield* makeFixture();
      const entered = yield* Deferred.make<boolean>();
      const runtime = yield* adaptAndroidRuntime({
        backend: {
          ...backend,
          activate: () =>
            Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never)),
        },
        startup: input,
      });
      const before = yield* runtime.observe();
      const fiber = yield* Effect.forkChild(
        runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(runtime.state()).toMatchObject({
        failure: { code: "execution_canceled" },
        observationId: null,
        outcome: "uncertain",
        phase: "paused",
      });
      yield* runtime.recover();
    })
);

it.effect(
  "serializes concurrent actions and closes once without reviving retained handles",
  () =>
    Effect.gen(function* concurrentDispatch() {
      const { commands, runtime } = yield* makeFixture();
      const before = yield* runtime.observe();
      const results = yield* Effect.all(
        [
          Effect.result(
            runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
          ),
          Effect.result(
            runtime.dispatch(before.id, { target: "@e1~s1", type: "activate" })
          ),
        ],
        { concurrency: "unbounded" }
      );
      expect(
        results.filter((result) => result._tag === "Success")
      ).toHaveLength(1);
      yield* runtime.close();
      yield* runtime.close();
      yield* Effect.flip(runtime.recover());
      yield* runtime.invalidate();
      expect(runtime.state().phase).toBe("closed");
      expect(commands).toEqual(["activate", "close"]);
    })
);

it.effect("retains typed cleanup failure in terminal state", () =>
  Effect.gen(function* failedCleanup() {
    const { backend, input } = yield* makeFixture();
    const runtime = yield* adaptAndroidRuntime({
      backend: {
        ...backend,
        close: () => Effect.fail(platformRuntimeError("cleanup_failed")),
      },
      startup: input,
    });
    yield* runtime.close();
    expect(runtime.state()).toMatchObject({
      failure: { code: "cleanup_failed" },
      phase: "closed",
    });
  })
);

it.effect(
  "routes platform-specific startup without fabricating browser handles",
  () =>
    Effect.gen(function* factoryRouting() {
      const { input, runtime } = yield* makeFixture();
      const factory = makePlatformRuntimeFactory(
        {
          capabilities: [],
          platform: "web",
          start: () => Effect.die("Unexpected browser acquisition"),
        },
        {
          capabilities: runtime.capabilities,
          createRun: () => Effect.die("Unexpected Run creation"),
          platform: "android",
          start: () => Effect.succeed(runtime),
        }
      );
      const result = yield* factory.start(input);
      expect(result.platform).toBe("android");
      expect("browser" in result).toBe(false);
      expect("browserSessionId" in result).toBe(false);
    })
);

it.effect(
  "incomplete capture invalidates prior evidence and cannot become a passing observation",
  () =>
    Effect.gen(function* incompleteCapture() {
      const { backend, input } = yield* makeFixture();
      let complete = true;
      const runtime = yield* adaptAndroidRuntime({
        backend: {
          ...backend,
          capture: () =>
            complete
              ? backend.capture()
              : Effect.fail(platformRuntimeError("capture_incomplete")),
        },
        startup: input,
      });
      const first = yield* runtime.observe();
      complete = false;
      expect((yield* Effect.flip(runtime.observe())).code).toBe(
        "capture_incomplete"
      );
      expect(runtime.state()).toMatchObject({
        observationId: null,
        phase: "paused",
      });
      yield* Effect.flip(
        runtime.dispatch(first.id, { target: "@e1~s1", type: "activate" })
      );
      complete = true;
      expect((yield* runtime.recover()).id).not.toBe(first.id);
    })
);

it.effect(
  "refuses foreign window targets and text that would need another helper",
  () =>
    Effect.gen(function* unsupportedTargets() {
      const { backend, commands, input } = yield* makeFixture();
      const runtime = yield* adaptAndroidRuntime({
        backend: {
          ...backend,
          capture: () =>
            backend.capture().pipe(
              Effect.map((observation) => ({
                ...observation,
                nodes: [
                  ...observation.nodes,
                  {
                    covered: false,
                    editable: true,
                    hittable: true,
                    name: "System window",
                    packageName: "dev.unrelated",
                    password: false,
                    role: "textbox",
                    target: "@e5~s1",
                  },
                ],
              }))
            ),
        },
        startup: input,
      });
      const first = yield* runtime.observe();
      expect(
        (yield* Effect.flip(
          runtime.dispatch(first.id, { target: "@e5~s1", type: "activate" })
        )).code
      ).toBe("target_unsupported");
      const next = yield* runtime.recover();
      expect(
        (yield* Effect.flip(
          runtime.dispatch(next.id, {
            target: "@e2~s1",
            text: "非公开",
            type: "fill",
          })
        )).code
      ).toBe("target_unsupported");
      expect(commands).toEqual([]);
    })
);

const privateValue = "sentinel-never-exported";
const variable = (resolutions: string[]) => ({
  value: Effect.sync(() => {
    resolutions.push("resolved");
    return Redacted.make(privateValue);
  }),
  variable: "account.password",
});

it.effect(
  "enters a private Variable through the helper without exposing its value",
  () =>
    Effect.gen(function* privateEntry() {
      const { commands, runtime } = yield* makeFixture([
        "semantic-actions",
        "private-input",
      ]);
      const resolutions: string[] = [];
      expect(runtime.capabilities).toContain("private-input");
      const before = yield* runtime.observe();
      const result = yield* runtime.enterPrivate(before.id, {
        target: "@e3~s1",
        ...variable(resolutions),
      });
      expect(result).toEqual({
        outcome: "verified",
        variable: "account.password",
      });
      expect(commands).toEqual(["private:@e3~s1"]);
      expect(resolutions).toEqual(["resolved"]);
      expect(runtime.state()).toMatchObject({
        observationId: null,
        outcome: "uncertain",
        phase: "ready",
      });
      expect(JSON.stringify([result, runtime.state()])).not.toContain(
        privateValue
      );
      // Agent-device keeps its session: the next semantic action needs only a fresh observation.
      const after = yield* runtime.observe();
      yield* runtime.dispatch(after.id, { target: "@e1~s1", type: "activate" });
      expect(commands).toEqual(["private:@e3~s1", "activate"]);
    })
);

it.effect(
  "refuses stale, unsupported, and undeclared private input before resolving the value",
  () =>
    Effect.gen(function* privateRefusals() {
      const resolutions: string[] = [];
      const declared = yield* makeFixture([
        "semantic-actions",
        "private-input",
      ]);
      const consumed = yield* declared.runtime.observe();
      yield* declared.runtime.dispatch(consumed.id, {
        target: "@e1~s1",
        type: "activate",
      });
      expect(
        (yield* Effect.flip(
          declared.runtime.enterPrivate(consumed.id, {
            target: "@e3~s1",
            ...variable(resolutions),
          })
        )).code
      ).toBe("observation_stale");
      // @e2 is editable but not a password field: its capture would export the value.
      for (const target of ["@e1~s1", "@e2~s1", "@e4~s1", "missing"]) {
        const observation = yield* declared.runtime.recover();
        expect(
          (yield* Effect.flip(
            declared.runtime.enterPrivate(observation.id, {
              target,
              ...variable(resolutions),
            })
          )).code
        ).toBe("target_unsupported");
        expect(declared.runtime.state().observationId).toBeNull();
      }
      const undeclared = yield* makeFixture();
      expect(undeclared.runtime.capabilities).not.toContain("private-input");
      const observation = yield* undeclared.runtime.observe();
      expect(
        (yield* Effect.flip(
          undeclared.runtime.enterPrivate(observation.id, {
            target: "@e3~s1",
            ...variable(resolutions),
          })
        )).code
      ).toBe("capability_missing");
      expect(resolutions).toEqual([]);
      expect(declared.commands).toEqual(["activate"]);
      expect(undeclared.commands).toEqual([]);
    })
);

it.effect("pauses after uncertain private input and never retries it", () =>
  Effect.gen(function* uncertainPrivate() {
    const { backend, input } = yield* makeFixture([
      "semantic-actions",
      "private-input",
    ]);
    let attempts = 0;
    const runtime = yield* adaptAndroidRuntime({
      backend: {
        ...backend,
        enterPrivate: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(platformRuntimeError("private_input_uncertain"));
          }),
      },
      startup: input,
    });
    const before = yield* runtime.observe();
    const request = { target: "@e3~s1", ...variable([]) };
    expect(
      (yield* Effect.flip(runtime.enterPrivate(before.id, request))).code
    ).toBe("private_input_uncertain");
    expect(runtime.state()).toMatchObject({
      failure: { code: "private_input_uncertain" },
      observationId: null,
      phase: "paused",
    });
    expect(
      (yield* Effect.flip(runtime.enterPrivate(before.id, request))).code
    ).toBe("runtime_paused");
    expect(attempts).toBe(1);
  })
);
