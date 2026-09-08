import {
  filterCookiesForOriginHost,
  httpOriginFromUrl,
  makeBrowserRpcError,
  sortCookiesByIdentity,
} from "@contingency/protocol";
import type {
  BrowserRpcErrorType,
  BrowserTabId,
  SessionId,
  StorageKind,
} from "@contingency/protocol";
import { Effect } from "effect";

import type {
  BrowserStorageDeleteInput,
  BrowserStorageSetInput,
} from "./create-browser-contract.ts";
import {
  activeStoragePage,
  emptyStorageSnapshot,
  normalizeCookie,
  tryBrowser,
} from "./create-browser-session.ts";
import type { CreateSession } from "./create-browser-session.ts";

type RequireSession = (
  sessionId: SessionId
) => Effect.Effect<CreateSession, BrowserRpcErrorType>;

type BrowserCookie = Parameters<
  CreateSession["context"]["addCookies"]
>[0][number];

const requireActivePage = (session: CreateSession, tabId: BrowserTabId) => {
  const page = activeStoragePage(session, tabId);
  return page === undefined
    ? Effect.fail(
        makeBrowserRpcError(
          "session_not_found",
          "The requested tab is not active."
        )
      )
    : Effect.succeed(page);
};

export const makeCreateBrowserStorage = (requireSession: RequireSession) => {
  const get = Effect.fn("CreateBrowser.getStorage")(function* readStorage(
    sessionId: SessionId,
    tabId: BrowserTabId,
    kind: StorageKind
  ) {
    const session = yield* requireSession(sessionId);
    const page = activeStoragePage(session, tabId);
    if (page === undefined) {
      return emptyStorageSnapshot(tabId, kind);
    }
    const origin = httpOriginFromUrl(page.url());
    if (origin === undefined) {
      return emptyStorageSnapshot(tabId, kind);
    }
    if (kind === "cookies") {
      const cookies = yield* tryBrowser("Could not inspect cookies", () =>
        session.context.cookies()
      );
      const normalized = cookies.map(normalizeCookie);
      return {
        cookies: sortCookiesByIdentity(
          filterCookiesForOriginHost(normalized, origin.host)
        ),
        kind,
        tabId,
      } as const;
    }
    const entries = yield* tryBrowser(`Could not inspect ${kind} storage`, () =>
      page.evaluate((storageKind) => {
        const storage = storageKind === "local" ? localStorage : sessionStorage;
        return Object.fromEntries(
          Array.from({ length: storage.length }, (_, index) => {
            const key = storage.key(index) ?? "";
            return [key, storage.getItem(key) ?? ""];
          })
        );
      }, kind)
    );
    return { entries, kind, tabId } as const;
  });

  const set = Effect.fn("CreateBrowser.setStorage")(function* writeStorage(
    sessionId: SessionId,
    tabId: BrowserTabId,
    input: BrowserStorageSetInput
  ) {
    const session = yield* requireSession(sessionId);
    const page = yield* requireActivePage(session, tabId);
    if (input.kind === "cookies") {
      const cookie: BrowserCookie = {
        domain: input.cookie.domain,
        httpOnly: input.cookie.httpOnly,
        name: input.cookie.name,
        path: input.cookie.path,
        secure: input.cookie.secure,
        value: input.cookie.value,
      };
      if (input.cookie.expires !== undefined) {
        cookie.expires = input.cookie.expires;
      }
      if (input.cookie.sameSite !== undefined) {
        cookie.sameSite = input.cookie.sameSite;
      }
      yield* tryBrowser("Could not set the cookie", () =>
        session.context.addCookies([cookie])
      );
      return;
    }
    yield* tryBrowser(`Could not set ${input.kind} storage`, () =>
      page.evaluate(({ key, kind, value }) => {
        const storage = kind === "local" ? localStorage : sessionStorage;
        storage.setItem(key, value);
      }, input)
    );
  });

  const remove = Effect.fn("CreateBrowser.deleteStorage")(
    function* removeStorage(
      sessionId: SessionId,
      tabId: BrowserTabId,
      input: BrowserStorageDeleteInput
    ) {
      const session = yield* requireSession(sessionId);
      const page = yield* requireActivePage(session, tabId);
      if (input.kind === "cookies") {
        yield* tryBrowser("Could not delete the cookie", () =>
          session.context.clearCookies({
            domain: input.domain,
            name: input.name,
            path: input.path,
          })
        );
        return;
      }
      yield* tryBrowser(`Could not delete ${input.kind} storage`, () =>
        page.evaluate(({ key, kind }) => {
          const storage = kind === "local" ? localStorage : sessionStorage;
          storage.removeItem(key);
        }, input)
      );
    }
  );

  const clear = Effect.fn("CreateBrowser.clearStorage")(
    function* clearSessionStorage(
      sessionId: SessionId,
      tabId: BrowserTabId,
      kind: StorageKind
    ) {
      const session = yield* requireSession(sessionId);
      const page = yield* requireActivePage(session, tabId);
      if (kind === "cookies") {
        const origin = httpOriginFromUrl(page.url());
        if (origin === undefined) {
          return;
        }
        const cookies = yield* tryBrowser("Could not inspect cookies", () =>
          session.context.cookies()
        );
        const inScope = filterCookiesForOriginHost(
          cookies.map(normalizeCookie),
          origin.host
        );
        for (const cookie of inScope) {
          yield* tryBrowser("Could not clear cookie", () =>
            session.context.clearCookies({
              domain: cookie.domain,
              name: cookie.name,
              path: cookie.path,
            })
          );
        }
        return;
      }
      yield* tryBrowser(`Could not clear ${kind} storage`, () =>
        page.evaluate((storageKind) => {
          const storage =
            storageKind === "local" ? localStorage : sessionStorage;
          storage.clear();
        }, kind)
      );
    }
  );

  return { clear, get, remove, set };
};
