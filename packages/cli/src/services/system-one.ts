import { Config, Context, Data, Effect, Layer, Option, Schedule } from "effect";
import type { Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { SystemOneResponseSchema } from "./system-one-request.ts";
import type {
  SystemOneRequest,
  SystemOneResponse,
} from "./system-one-request.ts";

/** How long one System One answer may take before the Pursuit fails. */
export const SYSTEM_ONE_REQUEST_TIMEOUT_MS = 10_000;

const SYSTEM_ONE_PATH = "/v1/systemone";

/**
 * Statuses that say the endpoint is briefly busy rather than wrong: rate
 * limited, unavailable, or overloaded. They are retried with backoff, once
 * or twice, inside the request timeout.
 */
const RETRYABLE_STATUSES = new Set([429, 503, 529]);
const RETRIES = 2;

/**
 * The machine's System One endpoint. Setting the URL is the user's consent to
 * send Pursuit requests to it, and nothing about it lives in the Catalog Root
 * ([ADR 0057](../../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 */
export interface SystemOneConfig {
  readonly apiKey: Option.Option<Redacted.Redacted<string>>;
  /** Tell the agent to try a Pursuit for each Flow Skill step first. */
  readonly first: boolean;
  readonly model: string;
  readonly url: string;
}

/** Accept either the server's origin or its full `/v1/systemone` route. */
const endpointUrl = (value: string): string => {
  const url = new URL(value.trim());
  if (!url.pathname.replace(/\/+$/u, "").endsWith(SYSTEM_ONE_PATH)) {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}${SYSTEM_ONE_PATH}`;
  }
  return url.toString();
};

/** A configured endpoint, or none when `CONTINGENCY_SYSTEM_ONE_URL` is unset. */
export const systemOneConfig = Config.all({
  apiKey: Config.Redacted("API_KEY").pipe(Config.option),
  first: Config.Boolean("FIRST").pipe(Config.withDefault(false)),
  model: Config.String("MODEL").pipe(Config.withDefault("jev-latest")),
  url: Config.String("URL").pipe(Config.option),
}).pipe(
  Config.nested("CONTINGENCY_SYSTEM_ONE"),
  Config.map(({ url, ...rest }) =>
    url.pipe(
      Option.filter((value) => value.trim() !== ""),
      Option.map((value): SystemOneConfig => ({
        ...rest,
        url: endpointUrl(value),
      }))
    )
  )
);

/** System One itself failed: the only failure that fails a Pursuit call. */
export class SystemOneError extends Data.TaggedError("SystemOneError")<{
  readonly message: string;
  readonly retryable?: boolean;
}> {}

export interface SystemOneService {
  readonly ask: (
    questions: Omit<SystemOneRequest, "model">
  ) => Effect.Effect<SystemOneResponse, SystemOneError>;
  readonly first: boolean;
}

export const SystemOne = Context.Service<SystemOneService>(
  "@contingency/SystemOne"
);

export const makeSystemOneLayer = (config: SystemOneConfig) =>
  Layer.effect(
    SystemOne,
    Effect.gen(function* makeSystemOne() {
      const client = yield* HttpClient.HttpClient;
      const ask: SystemOneService["ask"] = (questions) =>
        Effect.gen(function* askSystemOne() {
          const response = yield* client.execute(
            HttpClientRequest.post(config.url).pipe(
              (request) =>
                Option.match(config.apiKey, {
                  onNone: () => request,
                  onSome: (key) => HttpClientRequest.bearerToken(request, key),
                }),
              HttpClientRequest.bodyJsonUnsafe({
                ...questions,
                model: config.model,
              })
            )
          );
          if (response.status < 200 || response.status >= 300) {
            const detail = yield* response.text;
            return yield* new SystemOneError({
              message: `System One answered HTTP ${response.status}: ${detail.slice(0, 300)}`,
              retryable: RETRYABLE_STATUSES.has(response.status),
            });
          }
          return yield* HttpClientResponse.schemaBodyJson(
            SystemOneResponseSchema
          )(response);
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("250 millis"),
            times: RETRIES,
            while: (cause) =>
              cause._tag === "SystemOneError" && cause.retryable === true,
          }),
          Effect.timeout(SYSTEM_ONE_REQUEST_TIMEOUT_MS),
          Effect.mapError((cause) =>
            cause._tag === "SystemOneError"
              ? cause
              : new SystemOneError({
                  message:
                    cause._tag === "TimeoutError"
                      ? `System One did not answer within ${SYSTEM_ONE_REQUEST_TIMEOUT_MS / 1000} seconds.`
                      : `System One could not be reached or answered malformed JSON: ${cause.message}`,
                })
          )
        );
      return { ask, first: config.first };
    })
  ).pipe(Layer.provide(FetchHttpClient.layer));
