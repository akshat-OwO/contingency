import { isIP } from "node:net";

import type {
  AgentSessionId,
  AgentSessionSnapshot,
  BrowserDevtoolsCommand,
  BrowserModification,
} from "@contingency/protocol";
import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect, Ref } from "effect";

import { isTopLevelDocumentRequest } from "./agent-navigation-boundary.ts";
import { agentSessionError } from "./agent-session-error.ts";
import type { AgentSessionError } from "./agent-session-error.ts";
import { boundedDevtoolsText } from "./browser-devtools.ts";
import type { BrowserTarget } from "./create-browser-contract.ts";
import { domainScopeCovers, webHost } from "./domain-scope.ts";

// Browser-only global used inside Playwright evaluation callbacks.
declare const location: { readonly origin: string };

export type ModificationCommand = Extract<
  BrowserDevtoolsCommand,
  {
    action:
      | "cookie_set"
      | "cookie_clear"
      | "storage_set"
      | "storage_clear"
      | "route_add"
      | "headers_set"
      | "clipboard_write";
  }
>;
export const modificationKind = (
  command: ModificationCommand
): BrowserModification["kind"] => {
  switch (command.action) {
    case "cookie_set":
    case "cookie_clear": {
      return "cookie";
    }
    case "storage_set":
    case "storage_clear": {
      return "storage";
    }
    case "route_add": {
      return "route";
    }
    case "clipboard_write": {
      return "clipboard";
    }
    default: {
      return "headers";
    }
  }
};

/** One authority table for new writes and removal of existing writes. */
export const modificationRefusal = (
  snapshot: Pick<AgentSessionSnapshot, "activity" | "dryRun"> & {
    readonly origin?: "teaching" | "guided-run";
    readonly captureState?: { readonly _tag: string } | null;
  },
  kind: BrowserModification["kind"]
): string | undefined => {
  if (snapshot.origin === "guided-run") {
    return undefined;
  }
  if (snapshot.activity === "teaching") {
    if (snapshot.captureState?._tag !== "setup") {
      return "Browser state is fixed from Start to Stop during Teaching. Prepare it in agent-held Teaching setup.";
    }
    if (kind === "route" || kind === "headers" || kind === "eval") {
      return "Teaching setup allows cookie, storage, and Emulation writes only. Use an Interactive Run for routes, headers, or mutating evaluation.";
    }
  }
  return undefined;
};

/** Pursuits share Run authority; Teaching remains user-led. */
export const pursuitRefusal = (
  snapshot: Parameters<typeof modificationRefusal>[0]
): string | undefined =>
  snapshot.activity === "run" ||
  (snapshot.origin === "guided-run" &&
    (snapshot.captureState?._tag === "setup" ||
      snapshot.captureState?._tag === "recording"))
    ? undefined
    : "Pursuits run in Interactive Runs, Guided Run setup and capture, and Dry Runs. Teaching does not allow Pursuits.";

/** Cookie domains are bare hosts, optionally prefixed by the cookie domain dot. */
export const cookieWriteAllowed = (
  domain: string,
  currentUrl: string,
  allows?: (url: string) => boolean
): boolean => {
  const host = domain.replace(/^\./u, "").toLowerCase();
  // Reject URL syntax, ports, wildcard patterns, and malformed domain attributes.
  if (
    !host ||
    /[\s/:@*?#\\]/u.test(host) ||
    webHost(`https://${host}/`) !== host
  ) {
    return false;
  }
  return allows === undefined
    ? domainScopeCovers(webHost(currentUrl) ?? "", host)
    : allows(`https://${host}/`);
};
/** Chromium stores dotted IP and single-label domains as bare hosts. */
const storedCookieDomain = (domain: string): string => {
  const lower = domain.toLowerCase();
  const host = lower.replace(/^\./u, "");
  return !host.includes(".") || isIP(host) !== 0 ? host : lower;
};

export const storageWriteAllowed = (
  url: string,
  allows?: (url: string) => boolean
): boolean => webHost(url) !== undefined && (allows?.(url) ?? true);

export const modificationDescription = (
  command: ModificationCommand,
  secrets: readonly string[]
): string => {
  let description: string;
  switch (command.action) {
    case "cookie_set": {
      description = `Set cookie ${command.cookie.name} on ${command.cookie.domain}${command.cookie.path}: ${command.cookie.value}`;
      break;
    }
    case "cookie_clear": {
      description = `Clear cookie ${command.name} on ${command.domain}${command.path}`;
      break;
    }
    case "storage_set": {
      description = `Set ${command.kind} storage ${command.key}`;
      break;
    }
    case "storage_clear": {
      description = `Clear ${command.kind} storage${command.key === undefined ? "" : ` ${command.key}`}`;
      break;
    }
    case "clipboard_write": {
      description = `Write clipboard text: ${boundedDevtoolsText(command.text, secrets, 200).text}`;
      break;
    }
    case "headers_set": {
      description = `Set extra request headers: ${Object.keys(command.headers).join(", ") || "none"}`;
      break;
    }
    default: {
      description = `${command.response.action === "mock" ? "Mock" : "Block"} ${command.pattern}${command.resourceType === undefined ? "" : ` (${command.resourceType})`}${command.response.action === "mock" ? `: ${command.response.status} ${command.response.contentType}, ${boundedDevtoolsText(command.response.body, secrets, 2048).text}` : ""}`;
      break;
    }
  }
  return description;
};

const attempt = <A>(
  run: () => Promise<A>
): Effect.Effect<A, AgentSessionError> =>
  Effect.tryPromise({
    catch: () =>
      makeBrowserRpcError(
        "agent_browser_failed",
        "Could not apply the Browser Modification. Inspect the target and retry with a new operationId."
      ),
    try: run,
  });
type Write = Effect.Effect<void, AgentSessionError>;
interface Cell {
  readonly base: Write;
  readonly layers: readonly { readonly id: string; readonly write: Write }[];
}

/**
 * Private undo layers. A cell retains its original value while any modification
 * owns it. Removing an older layer cannot erase a newer agent write. Session
 * finalization drops the cells and their secrets along with the browser context.
 * Callers serialize all mutations with the session operation ledger.
 */
export const makeBrowserModifications = () =>
  Effect.gen(function* makeModifications() {
    const state = yield* Ref.make<
      ReadonlyMap<AgentSessionId, ReadonlyMap<string, Cell>>
    >(new Map());
    const cells = (sessionId: AgentSessionId) =>
      Ref.get(state).pipe(
        Effect.map(
          (sessions) => sessions.get(sessionId) ?? new Map<string, Cell>()
        )
      );
    const save = (sessionId: AgentSessionId, next: ReadonlyMap<string, Cell>) =>
      Ref.update(state, (sessions) => new Map(sessions).set(sessionId, next));
    const layer = (
      sessionId: AgentSessionId,
      id: string,
      key: string,
      base: Write,
      write: Write
    ) =>
      Effect.gen(function* writeLayer() {
        const current = yield* cells(sessionId);
        const cell = current.get(key) ?? { base, layers: [] };
        yield* write;
        yield* save(
          sessionId,
          new Map(current).set(key, {
            ...cell,
            layers: [...cell.layers, { id, write }],
          })
        );
      });
    const remove = (sessionId: AgentSessionId, id: string) =>
      Effect.gen(function* removeLayers() {
        const current = yield* cells(sessionId);
        for (const [key, cell] of current) {
          if (!cell.layers.some((entry) => entry.id === id)) {
            continue;
          }
          const layers = cell.layers.filter((entry) => entry.id !== id);
          if (cell.layers.at(-1)?.id === id) {
            yield* layers.at(-1)?.write ?? cell.base;
          }
          const next = new Map(yield* cells(sessionId));
          if (layers.length === 0) {
            next.delete(key);
          } else {
            next.set(key, { ...cell, layers });
          }
          yield* save(sessionId, next);
        }
      });
    const apply = (
      sessionId: AgentSessionId,
      id: string,
      // The clipboard belongs to the browser service; callers layer it directly.
      command: Exclude<ModificationCommand, { action: "clipboard_write" }>,
      target: BrowserTarget,
      allows?: (url: string) => boolean
    ) =>
      Effect.gen(function* applyModification() {
        const { context, page, tabId } = target;
        const currentUrl = page.url();
        if (
          command.action === "cookie_set" ||
          command.action === "cookie_clear"
        ) {
          const cookie =
            command.action === "cookie_set" ? command.cookie : command;
          if (!cookieWriteAllowed(cookie.domain, currentUrl, allows)) {
            return yield* Effect.fail(
              agentSessionError(
                "agent_session_conflict",
                "Cookie domain is outside the Domain Scope. Use a cookie on an allowed host; without a Domain Scope use the current page host."
              )
            );
          }
          const identity = {
            domain: storedCookieDomain(cookie.domain),
            name: cookie.name,
            path: cookie.path,
          };
          const prior = (yield* attempt(() => context.cookies())).find(
            (entry) =>
              entry.name === cookie.name &&
              entry.domain === identity.domain &&
              entry.path === cookie.path
          );
          const clear = attempt(() => context.clearCookies(identity));
          const base =
            prior === undefined
              ? clear
              : attempt(() => context.addCookies([prior]));
          let write = clear;
          if (command.action === "cookie_set") {
            const injected: Parameters<typeof context.addCookies>[0][number] = {
              ...identity,
              httpOnly: command.cookie.httpOnly,
              secure: command.cookie.secure,
              value: command.cookie.value,
            };
            if (command.cookie.expires !== undefined) {
              injected.expires = command.cookie.expires;
            }
            if (command.cookie.sameSite !== undefined) {
              injected.sameSite = command.cookie.sameSite;
            }
            write = attempt(() => context.addCookies([injected]));
          }
          yield* layer(
            sessionId,
            id,
            `cookie:${JSON.stringify(identity)}`,
            base,
            write
          );
          return;
        }
        if (
          command.action === "storage_set" ||
          command.action === "storage_clear"
        ) {
          if (!storageWriteAllowed(currentUrl, allows)) {
            return yield* Effect.fail(
              agentSessionError(
                "agent_session_conflict",
                "Storage writes require a current page origin inside the Domain Scope. Navigate to an allowed host first."
              )
            );
          }
          const { origin } = new URL(currentUrl);
          const entries = yield* attempt(() =>
            page.evaluate(
              ({ kind, expectedOrigin }) => {
                if (location.origin !== expectedOrigin) {
                  throw new Error("Storage origin changed");
                }
                const storage =
                  kind === "local" ? localStorage : sessionStorage;
                return Object.fromEntries(
                  Array.from({ length: storage.length }, (_, index) => {
                    const key = storage.key(index) ?? "";
                    return [key, storage.getItem(key)];
                  })
                );
              },
              { expectedOrigin: origin, kind: command.kind }
            )
          );
          const write = (key: string, value: string | null): Write =>
            Effect.gen(function* writeStorageCell() {
              if (new URL(page.url()).origin !== origin) {
                return yield* Effect.fail(
                  agentSessionError(
                    "agent_session_conflict",
                    `Return tab ${tabId} to ${origin} before removing this storage modification.`
                  )
                );
              }
              yield* attempt(() =>
                page.evaluate(
                  ({ kind, key: name, value: next, expectedOrigin }) => {
                    if (location.origin !== expectedOrigin) {
                      throw new Error("Storage origin changed");
                    }
                    const storage =
                      kind === "local" ? localStorage : sessionStorage;
                    if (next === null) {
                      storage.removeItem(name);
                    } else {
                      storage.setItem(name, next);
                    }
                  },
                  { expectedOrigin: origin, key, kind: command.kind, value }
                )
              );
            });
          const keys =
            command.key === undefined ? Object.keys(entries) : [command.key];
          for (const key of keys) {
            yield* layer(
              sessionId,
              id,
              `storage:${command.kind === "local" ? origin : `${tabId}:${origin}`}:${command.kind}:${key}`,
              write(key, entries[key] ?? null),
              write(
                key,
                command.action === "storage_set" ? command.value : null
              )
            );
          }
          return;
        }
        if (command.action === "headers_set") {
          // Contexts start without extra headers; subsequent layers preserve that base.
          yield* layer(
            sessionId,
            id,
            "headers",
            attempt(() => context.setExtraHTTPHeaders({})),
            attempt(() => context.setExtraHTTPHeaders({ ...command.headers }))
          );
          return;
        }
        const handler = async (
          route: Parameters<Parameters<typeof context.route>[1]>[0]
        ) => {
          const request = route.request();
          // Let the navigation boundary handle disallowed documents. Never fulfill
          // them here, even when a route matches every URL or a popup's first load.
          if (
            (isTopLevelDocumentRequest(request) &&
              allows !== undefined &&
              !allows(request.url())) ||
            (command.resourceType !== undefined &&
              request.resourceType() !== command.resourceType)
          ) {
            await route.fallback();
          } else if (command.response.action === "block") {
            await route.abort("blockedbyclient");
          } else {
            await route.fulfill({
              body: command.response.body,
              contentType: command.response.contentType,
              status: command.response.status,
            });
          }
        };
        yield* layer(
          sessionId,
          id,
          `route:${id}`,
          attempt(() => context.unroute(command.pattern, handler)),
          attempt(() => context.route(command.pattern, handler)).pipe(
            Effect.asVoid
          )
        );
      });
    return {
      apply,
      dispose: (sessionId: AgentSessionId) =>
        Ref.update(state, (sessions) => {
          const next = new Map(sessions);
          next.delete(sessionId);
          return next;
        }),
      layer,
      remove,
    };
  });
