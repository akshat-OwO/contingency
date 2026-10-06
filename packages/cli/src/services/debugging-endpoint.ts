/**
 * Where a launched Chromium serves its DevTools protocol. Chromium publishes
 * the endpoint in `DevToolsActivePort` once its debugging server listens.
 */

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** How long Chromium may take to publish its debugging endpoint. */
const DEBUGGING_ENDPOINT_TIMEOUT_MS = 10_000;
const DEBUGGING_ENDPOINT_POLL_MS = 25;
const BROWSER_ROUTE = "/devtools/browser/";

type ParsedEndpoint =
  | { readonly kind: "complete"; readonly endpoint: string }
  | { readonly kind: "partial" }
  | { readonly kind: "invalid" };

/**
 * The file holds the port, a newline, and the browser route. Contents that
 * are still a prefix of that shape may be a write in progress; anything else
 * can never become an endpoint.
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
  if (route.length > BROWSER_ROUTE.length && route.startsWith(BROWSER_ROUTE)) {
    return { endpoint: `ws://127.0.0.1:${port}${route}`, kind: "complete" };
  }
  return BROWSER_ROUTE.startsWith(route)
    ? { kind: "partial" }
    : { kind: "invalid" };
};

const pollDebuggingEndpoint = async (
  file: string,
  deadline: number
): Promise<string> => {
  // Until Chromium writes it, the file is missing; any read failure is
  // retried, and the deadline reports one that never clears.
  const contents = await readFile(file, "utf-8").catch(() => "");
  const parsed = parseDebuggingEndpoint(contents);
  if (parsed.kind === "complete") {
    return parsed.endpoint;
  }
  if (parsed.kind === "invalid") {
    throw new Error("Chromium published an invalid debugging endpoint.");
  }
  if (Date.now() >= deadline) {
    throw new Error(
      contents === ""
        ? "Chromium did not publish its debugging endpoint."
        : "Chromium published an incomplete debugging endpoint."
    );
  }
  await delay(DEBUGGING_ENDPOINT_POLL_MS);
  return pollDebuggingEndpoint(file, deadline);
};

/**
 * Read `DevToolsActivePort` until it holds a complete endpoint. Chromium can
 * write it after Playwright's launch resolves on a loaded machine, so a
 * missing or partly written file is read again until the timeout passes.
 */
export const readDebuggingEndpoint = (
  file: string,
  timeoutMs: number = DEBUGGING_ENDPOINT_TIMEOUT_MS
): Promise<string> => pollDebuggingEndpoint(file, Date.now() + timeoutMs);
