/**
 * Where a launched Chromium serves its DevTools protocol. Chromium publishes
 * the endpoint in `DevToolsActivePort` once its debugging server listens.
 */

import { readFile } from "node:fs/promises";

import { Clock, Effect } from "effect";

/** How long Chromium may take to publish its debugging endpoint. */
const DEBUGGING_ENDPOINT_TIMEOUT_MS = 10_000;
const DEBUGGING_ENDPOINT_POLL_MS = 25;
const BROWSER_ROUTE = "/devtools/browser/";
/** Chromium names the browser target with a UUID: hex digits laid out as below. */
const BROWSER_UUID_TEMPLATE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";

/** Whether `id` is the browser UUID or a prefix of it still being written. */
const browserIdProgress = (id: string): "complete" | "partial" | "invalid" => {
  if (id.length > BROWSER_UUID_TEMPLATE.length) {
    return "invalid";
  }
  for (const [index, character] of [...id].entries()) {
    const expected = BROWSER_UUID_TEMPLATE[index];
    const matches =
      expected === "-" ? character === "-" : /^[\da-f]$/iu.test(character);
    if (!matches) {
      return "invalid";
    }
  }
  return id.length === BROWSER_UUID_TEMPLATE.length ? "complete" : "partial";
};

type ParsedEndpoint =
  | { readonly kind: "complete"; readonly endpoint: string }
  | { readonly kind: "partial" }
  | { readonly kind: "invalid" };

/**
 * The file holds the port, a newline, and the browser route ending in the
 * browser's UUID. Contents that are still a prefix of that shape may be a
 * write in progress; anything else can never become an endpoint.
 */
const parseDebuggingEndpoint = (contents: string): ParsedEndpoint => {
  const [port = "", route, ...rest] = contents.trimEnd().split("\n");
  if (!/^\d*$/u.test(port) || rest.length > 0) {
    return { kind: "invalid" };
  }
  if (route === undefined) {
    return { kind: "partial" };
  }
  if (port === "") {
    return { kind: "invalid" };
  }
  if (!route.startsWith(BROWSER_ROUTE)) {
    return BROWSER_ROUTE.startsWith(route)
      ? { kind: "partial" }
      : { kind: "invalid" };
  }
  const progress = browserIdProgress(route.slice(BROWSER_ROUTE.length));
  return progress === "complete"
    ? { endpoint: `ws://127.0.0.1:${port}${route}`, kind: "complete" }
    : { kind: progress };
};

/**
 * Read `DevToolsActivePort` until it holds a complete endpoint. Chromium can
 * write it after Playwright's launch resolves on a loaded machine, so a
 * missing or partly written file is read again until the timeout passes.
 * The pause can be supplied by callers that control Chromium's publication.
 */
export const readDebuggingEndpoint = (
  file: string,
  timeoutMs: number = DEBUGGING_ENDPOINT_TIMEOUT_MS,
  pause: (milliseconds: number) => Effect.Effect<void> = Effect.sleep
): Effect.Effect<string, Error> =>
  Effect.gen(function* readEndpoint() {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (true) {
      // Until Chromium writes it, read failures are retried until the deadline.
      const contents = yield* Effect.promise(() =>
        readFile(file, "utf-8").catch(() => "")
      );
      const parsed = parseDebuggingEndpoint(contents);
      if (parsed.kind === "complete") {
        return parsed.endpoint;
      }
      if (parsed.kind === "invalid") {
        return yield* Effect.fail(
          new Error("Chromium published an invalid debugging endpoint.")
        );
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.fail(
          new Error(
            contents === ""
              ? "Chromium did not publish its debugging endpoint."
              : "Chromium published an incomplete debugging endpoint."
          )
        );
      }
      yield* pause(DEBUGGING_ENDPOINT_POLL_MS);
    }
  });
