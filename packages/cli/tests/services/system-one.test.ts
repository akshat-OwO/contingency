import { expect, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  Option,
  Redacted,
  Result,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import {
  makeSystemOneLayer,
  SystemOne,
} from "../../src/services/system-one.ts";
import type { SystemOneConfig } from "../../src/services/system-one.ts";

const questions = {
  questions: {},
  state: {
    elements: [],
    page: { content: [], title: "Test", url: "http://localhost/" },
    recent_actions: [],
  },
};
const config: SystemOneConfig = {
  apiKey: Option.some(Redacted.make("hosted-only-key")),
  first: false,
  model: "hosted",
  url: "https://example.com/v1/systemone",
};
const transport =
  (requests: Request[]): typeof fetch =>
  (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(
      Response.json({
        answers: {},
        model: "test",
        usage: { input_tokens: 0, output_tokens: 0 },
      })
    );
  };
const serviceWith = (settings: SystemOneConfig, requests: Request[]) =>
  SystemOne.pipe(
    Effect.provide(makeSystemOneLayer(settings)),
    Effect.provideService(FetchHttpClient.Fetch, transport(requests))
  );

it.effect(
  "uses local readiness, installed identity and no bearer credential",
  () =>
    Effect.gen(function* localRequest() {
      const requests: Request[] = [];
      const service = yield* serviceWith(
        {
          ...config,
          local: () =>
            Effect.succeed({
              model: "installed@revision",
              url: "http://127.0.0.1:4567/v1/systemone",
            }),
        },
        requests
      );
      yield* service.ask(questions, (yield* Clock.currentTimeMillis) + 1000);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      if (request === undefined) {
        return expect.unreachable();
      }
      expect(request.url).toBe("http://127.0.0.1:4567/v1/systemone");
      expect(request.headers.has("authorization")).toBe(false);
      const body: unknown = yield* Effect.promise(() => request.json());
      expect(body).toMatchObject({ model: "installed@revision" });
    })
);

it.effect("keeps hosted credentials on the explicit endpoint", () =>
  Effect.gen(function* hostedRequest() {
    const requests: Request[] = [];
    const service = yield* serviceWith(config, requests);
    yield* service.ask(questions);
    expect(requests[0]?.url).toBe(config.url);
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer hosted-only-key"
    );
  })
);

it.effect("includes warmup beyond ten seconds inside the Pursuit budget", () =>
  Effect.gen(function* warmupBudget() {
    const ready = yield* Deferred.make<boolean>();
    const service = yield* serviceWith(
      {
        ...config,
        local: () =>
          Deferred.await(ready).pipe(
            Effect.as({
              model: "local",
              url: "http://127.0.0.1:4567/v1/systemone",
            })
          ),
      },
      []
    );
    const waiting = yield* service
      .ask(questions, (yield* Clock.currentTimeMillis) + 30_000)
      .pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust(15_000);
    yield* Deferred.succeed(ready, true);
    expect(Result.isSuccess(yield* Fiber.join(waiting))).toBe(true);
  })
);
