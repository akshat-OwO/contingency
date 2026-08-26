import { randomUUID } from "node:crypto";

import { BrowserRequestId, BrowserTabId } from "@contingency/protocol";
import { Effect, PubSub, Ref } from "effect";
import type { ConsoleMessage, Page, Request, Response } from "playwright-core";

import { restartScreencast } from "./create-browser-screencast.ts";
import {
  applyEmulationToPage,
  publishTabs,
  readSessionState,
  reportCallbackFailure,
  tryBrowser,
  updateSessionState,
} from "./create-browser-session.ts";
import type { CreateSession } from "./create-browser-session.ts";

export const initializePage = (session: CreateSession, page: Page): void => {
  const tabId = BrowserTabId.make(randomUUID());
  updateSessionState(session, (state) => ({
    ...state,
    network: new Map(state.network).set(tabId, new Map()),
    pageIds: new Map(state.pageIds).set(page, tabId),
    titles: new Map(state.titles).set(page, ""),
  }));

  page.on("console", (message: ConsoleMessage) => {
    PubSub.publishUnsafe(session.events, {
      level: message.type(),
      tabId,
      text: message.text(),
      timestamp: Date.now(),
      type: "console",
    });
  });
  page.on("pageerror", (error: Error) => {
    PubSub.publishUnsafe(session.events, {
      column: null,
      line: null,
      tabId,
      text: error.message,
      timestamp: Date.now(),
      type: "page_error",
    });
  });
  page.on("domcontentloaded", () => {
    Effect.runFork(
      reportCallbackFailure(
        session,
        Effect.gen(function* readPageTitle() {
          const title = yield* tryBrowser("Could not read the Page title", () =>
            page.title()
          );
          updateSessionState(session, (state) => ({
            ...state,
            titles: new Map(state.titles).set(page, title),
          }));
          publishTabs(session);
        })
      )
    );
  });
  page.on("request", (request: Request) => {
    const requestId = BrowserRequestId.make(randomUUID());
    Effect.runSync(
      Ref.update(session.state, (state) => {
        state.network.get(tabId)?.set(requestId, {
          request: {
            headers: request.headers(),
            method: request.method(),
            postData: request.postData() ?? undefined,
            requestId,
            resourceType: request.resourceType(),
            tabId,
            timestamp: Date.now(),
            url: request.url(),
          },
        });
        state.requestIds.set(request, requestId);
        return state;
      })
    );
  });
  page.on("response", (response: Response) => {
    const request = response.request();
    const state = readSessionState(session);
    const requestId = state.requestIds.get(request);
    if (requestId === undefined) {
      return;
    }
    const record = state.network.get(tabId)?.get(requestId);
    if (record === undefined) {
      return;
    }
    Effect.runSync(
      Ref.update(session.state, (current) => {
        current.network.get(tabId)?.set(requestId, {
          request: {
            ...record.request,
            mimeType: response.headers()["content-type"],
            responseHeaders: response.headers(),
            status: response.status(),
          },
          response,
        });
        current.requestIds.delete(request);
        return current;
      })
    );
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }
    PubSub.publishUnsafe(session.events, {
      tabId,
      timestamp: Date.now(),
      type: "url",
      url: page.url(),
    });
    publishTabs(session);
  });
  page.on("close", () => {
    const replacement = Effect.runSync(
      Ref.modify(session.state, (state) => {
        const pageIds = new Map(state.pageIds);
        const network = new Map(state.network);
        const titles = new Map(state.titles);
        pageIds.delete(page);
        network.delete(tabId);
        titles.delete(page);
        const [nextPage] = pageIds.keys();
        return [
          state.activePage === page ? nextPage : undefined,
          {
            ...state,
            ...(state.activePage === page && nextPage !== undefined
              ? { activePage: nextPage }
              : {}),
            network,
            pageIds,
            titles,
          },
        ];
      })
    );
    if (replacement !== undefined) {
      Effect.runFork(
        reportCallbackFailure(session, restartScreencast(session))
      );
    }
    publishTabs(session);
  });
  // A new Page — a tab or a popup — joins the session's Emulation like every
  // other one, because the session emulates one device in one environment.
  Effect.runFork(
    reportCallbackFailure(session, applyEmulationToPage(session, page))
  );
  publishTabs(session);
};
