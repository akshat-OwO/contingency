import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "@effect/vitest";
import { createAgentDeviceClient } from "agent-device";
import { Effect, Schema } from "effect";

// Covers the in-repo agent-device patch for callstack/agent-device#4413: a ref
// click or press may tap a point inside the ref's frame instead of its center.
const AGENT_DEVICE_SRC = path.resolve(
  import.meta.dirname,
  "../../node_modules/agent-device/dist/src"
);

const PointSchema = Schema.Struct({ x: Schema.Number, y: Schema.Number });
type Point = typeof PointSchema.Type;
const decodeClickFlags = Schema.decodeUnknownSync(
  Schema.Struct({
    offset: Schema.optionalKey(PointSchema),
    point: Schema.optionalKey(PointSchema),
  })
);

interface RefClickOptions {
  readonly offset?: Point;
  readonly point?: Point;
  readonly session?: string;
}

type ClickTarget =
  | { readonly kind: "point"; readonly x: number; readonly y: number }
  | { readonly kind: "ref"; readonly ref: string };

interface RuntimeInteractions {
  readonly click: (
    target: ClickTarget,
    options: RefClickOptions
  ) => Promise<object>;
}

interface CorpusSession {
  readonly name: string;
  readonly snapshot: {
    readonly createdAt: number;
    readonly nodes: readonly object[];
  };
}

interface RuntimeConfig {
  readonly backend: {
    readonly captureSnapshot: () => Promise<{
      readonly snapshot: CorpusSession["snapshot"];
    }>;
    readonly platform: "ios";
    readonly tap: (context: BackendContext, point: Point) => Promise<object>;
  };
  readonly sessions: {
    readonly delete: () => void;
    readonly get: (name: string) => CorpusSession | undefined;
    readonly list: () => readonly CorpusSession[];
    readonly set: () => void;
  };
}

/** The per-command context the runtime hands its backend; opaque to this test. */
interface BackendContext {
  readonly signal?: AbortSignal;
}

/** The normalized runtime the interaction surface reads; opaque to this test. */
interface AgentDeviceRuntime {
  readonly backend: RuntimeConfig["backend"];
}

interface RuntimeFactoryModule {
  readonly a: (runtime: AgentDeviceRuntime) => RuntimeInteractions;
  readonly t: (config: RuntimeConfig) => AgentDeviceRuntime;
}

const NOTIFICATIONS = { height: 28, width: 364, x: 20, y: 306 };

const loadRuntime = Effect.promise(async () => {
  // SAFETY: Patched `agent-device/dist/src/runtime-factory.js` exports the
  // runtime config normalizer as `t` and the interaction surface as `a`.
  const mod = (await import(
    pathToFileURL(path.join(AGENT_DEVICE_SRC, "runtime-factory.js")).href
  )) as RuntimeFactoryModule;
  const taps: Point[] = [];
  const session: CorpusSession = {
    name: "default",
    snapshot: {
      createdAt: 0,
      nodes: [
        {
          hittable: true,
          index: 0,
          rect: { height: 874, width: 402, x: 0, y: 0 },
          ref: "e1",
          type: "Application",
        },
        {
          hittable: true,
          index: 1,
          label: "Notifications",
          parentIndex: 0,
          rect: NOTIFICATIONS,
          ref: "e2",
          type: "Switch",
        },
      ],
    },
  };
  const runtime = mod.t({
    backend: {
      captureSnapshot: () => Promise.resolve({ snapshot: session.snapshot }),
      platform: "ios",
      tap: (_context, point) => {
        taps.push(point);
        return Promise.resolve({});
      },
    },
    sessions: {
      delete: () => {},
      get: (name) => (name === session.name ? session : undefined),
      list: () => [session],
      set: () => {},
    },
  });
  return { interactions: mod.a(runtime), taps };
});

const click = (interactions: RuntimeInteractions, options: RefClickOptions) =>
  Effect.tryPromise(() =>
    interactions.click(
      { kind: "ref", ref: "@e2" },
      { session: "default", ...options }
    )
  );

it.effect("keeps a plain ref click on the frame center", () =>
  Effect.gen(function* plainRefClick() {
    const { interactions, taps } = yield* loadRuntime;
    yield* click(interactions, {});
    expect(taps).toEqual([{ x: 202, y: 320 }]);
  })
);

it.effect("taps a ref at an absolute point or an offset inside its frame", () =>
  Effect.gen(function* refClickAtPoint() {
    const { interactions, taps } = yield* loadRuntime;
    yield* click(interactions, { point: { x: 46, y: 320 } });
    yield* click(interactions, { offset: { x: 26, y: 14 } });
    expect(taps).toEqual([
      { x: 46, y: 320 },
      { x: 46, y: 320 },
    ]);
  })
);

it.effect("refuses a point outside the ref's frame before dispatch", () =>
  Effect.gen(function* refusesOutsidePoint() {
    const { interactions, taps } = yield* loadRuntime;
    const failure = yield* Effect.flip(
      click(interactions, { point: { x: 10, y: 320 } })
    );
    expect(failure.cause).toMatchObject({
      code: "COMMAND_FAILED",
      details: {
        dispatched: "no",
        point: { x: 10, y: 320 },
        reason: "point_outside_target",
        rect: NOTIFICATIONS,
        ref: "@e2",
      },
    });
    expect(taps).toEqual([]);
  })
);

it.effect(
  "refuses a point on anything but a single ref, or with an offset too",
  () =>
    Effect.gen(function* refusesMisuse() {
      const { interactions, taps } = yield* loadRuntime;
      const both = yield* Effect.flip(
        click(interactions, {
          offset: { x: 1, y: 1 },
          point: { x: 46, y: 320 },
        })
      );
      expect(both.cause).toMatchObject({ code: "INVALID_ARGS" });
      const onPoint = yield* Effect.flip(
        Effect.tryPromise(() =>
          interactions.click(
            { kind: "point", x: 46, y: 320 },
            { point: { x: 46, y: 320 } }
          )
        )
      );
      expect(onPoint.cause).toMatchObject({ code: "INVALID_ARGS" });
      expect(taps).toEqual([]);
    })
);

it.effect(
  "sends the point and offset to the daemon as click and press flags",
  () =>
    Effect.gen(function* clientFlags() {
      const sent: (typeof decodeClickFlags extends (input: never) => infer A
        ? A
        : never)[] = [];
      const client = createAgentDeviceClient(
        { session: "default" },
        {
          transport: (request) => {
            sent.push(decodeClickFlags(request.flags ?? {}));
            return Promise.resolve({ data: {}, ok: true });
          },
        }
      );
      yield* Effect.promise(() =>
        client.interactions.click({ point: { x: 46, y: 320 }, ref: "@e2~s1" })
      );
      yield* Effect.promise(() =>
        client.interactions.press({ offset: { x: 26, y: 14 }, ref: "@e2~s1" })
      );
      expect(sent).toEqual([
        { point: { x: 46, y: 320 } },
        { offset: { x: 26, y: 14 } },
      ]);
    })
);
