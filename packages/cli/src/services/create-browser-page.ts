import { randomUUID } from "node:crypto";

import { BrowserTabId } from "@contingency/protocol";
import { Effect, PubSub, Ref } from "effect";
import type { Page, Request, Response } from "playwright-core";

import { botProtectionProvider } from "./bot-protection.ts";
import { makeTabDevtools } from "./browser-devtools.ts";
import { restartScreencast } from "./create-browser-screencast.ts";
import {
  applyEmulationToPage,
  publishTabs,
  reportCallbackFailure,
  trackPageTitle,
  updateSessionState,
} from "./create-browser-session.ts";
import type { CreateSession } from "./create-browser-session.ts";
import { trackPageNetwork } from "./page-activity.ts";

export const initializePage = (
  session: CreateSession,
  page: Page,
  earlyRequests: readonly Request[] = []
): void => {
  const tabId = BrowserTabId.make(randomUUID());
  const tools = makeTabDevtools(page, tabId, (entry) => {
    PubSub.publishUnsafe(session.events, entry);
  });
  for (const request of earlyRequests) {
    tools.adopt(request);
  }
  updateSessionState(session, (state) => ({
    ...state,
    devtools: new Map(state.devtools).set(tabId, tools),
    pageIds: new Map(state.pageIds).set(page, tabId),
    titles: new Map(state.titles).set(page, ""),
  }));

  trackPageNetwork(page);
  page.on("response", (response: Response) => {
    const provider = botProtectionProvider(
      response.status(),
      response.headers()
    );
    if (provider !== undefined) {
      PubSub.publishUnsafe(session.events, {
        provider,
        status: response.status(),
        tabId,
        timestamp: Date.now(),
        type: "bot_protection_block",
        url: response.url(),
      });
    }
  });
  page.on("download", (download) => {
    PubSub.publishUnsafe(session.downloads, {
      download,
      startedAt: Date.now(),
      tabId,
    });
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
        const devtools = new Map(state.devtools);
        const titles = new Map(state.titles);
        pageIds.delete(page);
        devtools.delete(tabId);
        titles.delete(page);
        const [nextPage] = pageIds.keys();
        const nextState = { ...state, devtools, pageIds, titles };
        const updatedState =
          state.activePage === page && nextPage !== undefined
            ? { ...nextState, activePage: nextPage }
            : nextState;
        return [state.activePage === page ? nextPage : undefined, updatedState];
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
  Effect.runFork(reportCallbackFailure(session, trackPageTitle(session, page)));
  publishTabs(session);
};
