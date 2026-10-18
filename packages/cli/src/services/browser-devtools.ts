import { randomUUID } from "node:crypto";

import { BrowserRequestId, makeBrowserRpcError } from "@contingency/protocol";
import type {
  BrowserConsoleEntry,
  BrowserDevtoolsCommand,
  BrowserNetworkRequest,
  BrowserNetworkRequestDetail,
  BrowserTabId,
} from "@contingency/protocol";
import { Effect, Predicate, Schema } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { Page, Request, Response } from "playwright-core";

import { redactKnownValues } from "./agent-browser.ts";

export const DEVTOOLS_LIMITS = {
  bodyBytes: 65_536,
  console: 500,
  requests: 500,
  textBytes: 8192,
} as const;
const credentialHeaders = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

/** Scrub the literal and its common transport encodings before clipping any text. */
export const redactDevtoolsText = (text: string, secrets: readonly string[]) =>
  redactKnownValues(
    text,
    secrets.flatMap((secret) => [
      secret,
      encodeURIComponent(secret.toWellFormed()),
      new URLSearchParams({ value: secret }).toString().slice(6),
      JSON.stringify(secret).slice(1, -1),
    ])
  );

export const redactDevtoolsJson = (
  value: Schema.Json,
  secrets: readonly string[]
): Schema.Json => {
  if (Predicate.isString(value)) {
    return redactDevtoolsText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item: Schema.Json) => redactDevtoolsJson(item, secrets));
  }
  if (
    value === null ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redactDevtoolsText(key, secrets),
      redactDevtoolsJson(item, secrets),
    ])
  );
};

export const redactDevtoolsHeaders = (
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[]
) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      redactDevtoolsText(name, secrets),
      credentialHeaders.has(name.toLowerCase())
        ? "[redacted]"
        : redactDevtoolsText(value, secrets),
    ])
  );

export const boundedDevtoolsText = (
  text: string,
  secrets: readonly string[],
  limit: number = DEVTOOLS_LIMITS.bodyBytes
) => {
  const bytes = Buffer.from(redactDevtoolsText(text, secrets));
  const prefix = bytes.subarray(0, limit).toString("utf-8");
  return {
    text: prefix.endsWith("\uFFFD") ? prefix.slice(0, -1) : prefix,
    truncated: bytes.length > limit,
  };
};

export const redactDevtoolsRequest = (
  request: BrowserNetworkRequestDetail,
  secrets: readonly string[]
): BrowserNetworkRequestDetail => {
  const post = boundedDevtoolsText(request.postData ?? "", secrets);
  const body = boundedDevtoolsText(request.responseBody ?? "", secrets);
  return {
    ...request,
    bodyTruncated:
      request.bodyTruncated === true || post.truncated || body.truncated,
    headers: redactDevtoolsHeaders(request.headers, secrets),
    mimeType:
      request.mimeType === undefined
        ? undefined
        : redactDevtoolsText(request.mimeType, secrets),
    postData: request.postData === undefined ? undefined : post.text,
    responseBody: request.responseBody === undefined ? undefined : body.text,
    responseHeaders:
      request.responseHeaders === undefined || request.responseHeaders === null
        ? undefined
        : redactDevtoolsHeaders(request.responseHeaders, secrets),
    url: redactDevtoolsText(request.url, secrets),
  };
};

type RequestsCommand = Extract<
  BrowserDevtoolsCommand,
  { readonly action: "requests" }
>;

/** Request metadata: everything except headers and bodies, which `request` returns by id. */
export type DevtoolsRequestMetadata = Omit<
  BrowserNetworkRequestDetail,
  "headers" | "postData" | "responseBody" | "responseHeaders"
>;

/**
 * Redacts each request, applies the `requests` filter to the redacted URL,
 * and projects the survivors to metadata. `dropped` is the tab's retention count.
 */
export interface DevtoolsRequestsResult {
  readonly dropped: number;
  readonly requests: readonly DevtoolsRequestMetadata[];
}

export const filterDevtoolsRequests = (
  listing: {
    readonly dropped: number;
    readonly requests: readonly BrowserNetworkRequest[];
  },
  command: RequestsCommand,
  secrets: readonly string[]
): DevtoolsRequestsResult => ({
  dropped: listing.dropped,
  requests: listing.requests.flatMap((raw) => {
    const request = redactDevtoolsRequest(raw, secrets);
    if (
      !(
        (command.url === undefined || request.url.includes(command.url)) &&
        (command.method === undefined ||
          request.method.toUpperCase() === command.method.toUpperCase()) &&
        (command.statusMin === undefined ||
          (request.status !== undefined &&
            request.status !== null &&
            request.status >= command.statusMin)) &&
        (command.statusMax === undefined ||
          (request.status !== undefined &&
            request.status !== null &&
            request.status <= command.statusMax)) &&
        (command.resourceType === undefined ||
          request.resourceType === command.resourceType)
      )
    ) {
      return [];
    }
    const {
      headers: _headers,
      responseHeaders: _responseHeaders,
      postData: _postData,
      responseBody: _responseBody,
      ...metadata
    } = request;
    return [metadata];
  }),
});

interface RecordEntry {
  readonly metadata: BrowserNetworkRequest;
  readonly request: Request;
  readonly response?: Response;
  readonly finished?: boolean;
}
interface State {
  readonly records: readonly RecordEntry[];
  readonly console: readonly BrowserConsoleEntry[];
  readonly dropped: number;
  readonly consoleDropped: number;
  readonly capture: readonly RecordEntry[] | undefined;
  readonly captureDropped: number;
  readonly captureId?: string;
  readonly stopped?:
    | { readonly id: string; readonly har: Schema.Json }
    | undefined;
}

/** One tab owns observation, bounded retention, and explicit HAR capture from its creation. */
export const makeTabDevtools = (
  page: Page,
  tabId: BrowserTabId,
  emit: (entry: BrowserConsoleEntry) => void
) => {
  const registry = AtomRegistry.make();
  const state = Atom.make<State>({
    capture: undefined,
    captureDropped: 0,
    console: [],
    consoleDropped: 0,
    dropped: 0,
    records: [],
  }).pipe(Atom.keepAlive);
  const update = (f: (current: State) => State) => registry.update(state, f);
  const appendConsole = (entry: BrowserConsoleEntry) => {
    const bounded = {
      ...entry,
      text:
        Buffer.byteLength(entry.text) > DEVTOOLS_LIMITS.textBytes
          ? "[content omitted: size limit]"
          : entry.text,
    };
    update((current) => ({
      ...current,
      console: [...current.console, bounded].slice(-DEVTOOLS_LIMITS.console),
      consoleDropped:
        current.consoleDropped +
        Number(current.console.length >= DEVTOOLS_LIMITS.console),
    }));
    emit(bounded);
  };
  page.on("console", (message) =>
    appendConsole({
      level: message.type(),
      tabId,
      text: message.text(),
      timestamp: Date.now(),
      type: "console",
    })
  );
  page.on("pageerror", (error) =>
    appendConsole({
      column: null,
      line: null,
      tabId,
      text: error.message,
      timestamp: Date.now(),
      type: "page_error",
    })
  );
  const onRequest = (request: Request) => {
    const entry: RecordEntry = {
      metadata: {
        durationMs: undefined,
        headers: request.headers(),
        method: request.method(),
        requestId: BrowserRequestId.make(randomUUID()),
        resourceType: request.resourceType(),
        size: undefined,
        tabId,
        timestamp: Date.now(),
        url: request.url(),
      },
      request,
    };
    update((current) => ({
      ...current,
      capture:
        current.capture === undefined
          ? undefined
          : [...current.capture, entry].slice(-DEVTOOLS_LIMITS.requests),
      captureDropped:
        current.captureDropped +
        Number((current.capture?.length ?? 0) >= DEVTOOLS_LIMITS.requests),
      dropped:
        current.dropped +
        Number(current.records.length >= DEVTOOLS_LIMITS.requests),
      records: [...current.records, entry].slice(-DEVTOOLS_LIMITS.requests),
    }));
  };
  page.on("request", onRequest);
  const amend = (
    request: Request,
    change: (entry: RecordEntry) => RecordEntry
  ) =>
    update((current) => ({
      ...current,
      capture: current.capture?.map((entry) =>
        entry.request === request ? change(entry) : entry
      ),
      records: current.records.map((entry) =>
        entry.request === request ? change(entry) : entry
      ),
    }));
  const onResponse = (response: Response) =>
    amend(response.request(), (entry) => ({
      ...entry,
      metadata: {
        ...entry.metadata,
        mimeType: response.headers()["content-type"],
        responseHeaders: response.headers(),
        status: response.status(),
      },
      response,
    }));
  page.on("response", onResponse);
  const onFinished = (request: Request) => {
    // The event marks timing complete. Sizes are asynchronous in Playwright.
    amend(request, (entry) => ({
      ...entry,
      finished: true,
      metadata: { ...entry.metadata, durationMs: request.timing().responseEnd },
    }));
    Effect.runFork(
      Effect.tryPromise(() => request.sizes()).pipe(
        Effect.tap((sizes) =>
          Effect.sync(() => {
            if (!page.isClosed()) {
              amend(request, (entry) => ({
                ...entry,
                metadata: { ...entry.metadata, size: sizes.responseBodySize },
              }));
            }
          })
        ),
        Effect.ignore
      )
    );
  };
  page.on("requestfinished", onFinished);
  const detail = (entry: RecordEntry, secrets: readonly string[]) =>
    Effect.gen(function* readBody() {
      const { response } = entry;
      const body =
        response === undefined || entry.finished !== true
          ? undefined
          : yield* Effect.tryPromise({
              catch: () =>
                makeBrowserRpcError(
                  "agent_browser_failed",
                  "Response body is unavailable."
                ),
              try: () => response.body(),
            }).pipe(Effect.option);
      const bytes = body?._tag === "Some" ? body.value : undefined;
      const headers =
        entry.finished === true
          ? yield* Effect.tryPromise(() => entry.request.allHeaders()).pipe(
              Effect.orElseSucceed(() => entry.metadata.headers)
            )
          : entry.metadata.headers;
      const responseHeaders =
        response === undefined || entry.finished !== true
          ? entry.metadata.responseHeaders
          : yield* Effect.tryPromise(() => response.allHeaders()).pipe(
              Effect.orElseSucceed(() => entry.metadata.responseHeaders)
            );
      return redactDevtoolsRequest(
        {
          ...entry.metadata,
          bodyTruncated: false,
          bodyUnavailable: bytes === undefined,
          headers,
          postData: entry.request.postData() ?? undefined,
          responseBody: bytes?.toString("utf-8"),
          responseHeaders,
        },
        secrets
      );
    });
  page.once("close", () => registry.dispose());
  /**
   * Take a request the page issued before this tab existed: a popup's first
   * document is requested before Playwright reports the popup.
   */
  const adopt = (request: Request) => {
    onRequest(request);
    Effect.runFork(
      Effect.tryPromise(() => request.response()).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            if (response !== null) {
              onResponse(response);
              onFinished(request);
            }
          })
        ),
        Effect.ignore
      )
    );
  };
  return {
    adopt,
    clearConsole: () =>
      update((current) => ({ ...current, console: [], consoleDropped: 0 })),
    console: (secrets: readonly string[]) => {
      const current = registry.get(state);
      return {
        dropped: current.consoleDropped,
        entries: current.console.map((entry) => ({
          ...entry,
          text: redactDevtoolsText(entry.text, secrets),
        })),
      };
    },
    request: (id: string, secrets: readonly string[]) => {
      const entry = registry
        .get(state)
        .records.find(({ metadata }) => metadata.requestId === id);
      return entry === undefined
        ? Effect.fail(
            makeBrowserRpcError(
              "agent_browser_failed",
              "Request was dropped or does not exist in this tab."
            )
          )
        : detail(entry, secrets);
    },
    requests: () => {
      const current = registry.get(state);
      return {
        dropped: current.dropped,
        requests: current.records.map(({ metadata }) => metadata),
      };
    },
    startHar: (id: string) =>
      update((current) =>
        current.captureId === id
          ? current
          : {
              ...current,
              capture: [],
              captureDropped: 0,
              captureId: id,
              stopped: undefined,
            }
      ),
    stopHar: (secrets: readonly string[], id: string) =>
      Effect.gen(function* stopCapture() {
        const current = registry.get(state);
        if (current.stopped?.id === id) {
          return redactDevtoolsJson(current.stopped.har, secrets);
        }
        if (current.capture === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_browser_failed",
              "HAR capture is not active."
            )
          );
        }
        // Detach the window before reading bodies, so later traffic is outside this capture.
        update((next) => ({ ...next, capture: undefined, captureDropped: 0 }));
        // Effect.forEach takes its callback second, unlike Array.forEach.
        // oxlint-disable-next-line unicorn/no-array-method-this-argument
        const entries = yield* Effect.forEach(current.capture, (entry) =>
          detail(entry, secrets).pipe(
            Effect.map((request) => ({
              cache: {},
              request: {
                bodySize: -1,
                cookies: [],
                headers: Object.entries(request.headers).map(
                  ([name, value]) => ({ name, value })
                ),
                headersSize: -1,
                httpVersion: "HTTP/1.1",
                method: request.method,
                postData: {
                  mimeType: request.headers["content-type"] ?? "",
                  text: request.postData ?? "",
                },
                queryString: [],
                url: request.url,
              },
              response: {
                bodySize: request.size ?? -1,
                content: {
                  _truncated: request.bodyTruncated,
                  _unavailable: request.bodyUnavailable,
                  mimeType: request.mimeType ?? "",
                  size: request.size ?? -1,
                  text: request.responseBody ?? "",
                },
                cookies: [],
                headers: Object.entries(request.responseHeaders ?? {}).map(
                  ([name, value]) => ({ name, value })
                ),
                headersSize: -1,
                httpVersion: "HTTP/1.1",
                redirectURL: "",
                status: request.status ?? 0,
                statusText: "",
              },
              startedDateTime: new Date(request.timestamp).toISOString(),
              time: request.durationMs ?? 0,
              timings: { receive: 0, send: 0, wait: request.durationMs ?? 0 },
            }))
          )
        );
        const har = {
          log: {
            _dropped: current.captureDropped,
            creator: { name: "Contingency", version: "1" },
            entries,
            version: "1.2",
          },
        };
        const safeHar = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Json)
        )(JSON.stringify(har)).pipe(
          Effect.mapError(() =>
            makeBrowserRpcError(
              "agent_browser_failed",
              "Could not encode the captured HAR."
            )
          )
        );
        update((next) =>
          next.captureId === current.captureId
            ? { ...next, stopped: { har: safeHar, id } }
            : next
        );
        return safeHar;
      }),
  };
};
export type TabDevtools = ReturnType<typeof makeTabDevtools>;
