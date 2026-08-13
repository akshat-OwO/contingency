import type {
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserTabId,
  SessionId,
} from "@contingency/protocol";
import { Atom } from "effect/unstable/reactivity";

const MAX_CONSOLE_ENTRIES = 10_000;
const MAX_NETWORK_REQUESTS = 10_000;

export interface TabDevtoolsData {
  readonly consoleEntries: readonly BrowserConsoleEntry[];
  readonly networkRequests: readonly BrowserNetworkRequest[];
}

interface SessionDevtoolsData {
  readonly ignoredRequestIds: Readonly<Record<string, true>>;
  readonly tabs: Readonly<Record<string, TabDevtoolsData>>;
}

export interface BrowserDevtoolsState {
  readonly sessions: Readonly<Record<string, SessionDevtoolsData>>;
}

const emptyTabData: TabDevtoolsData = {
  consoleEntries: [],
  networkRequests: [],
};

const emptySessionData: SessionDevtoolsData = {
  ignoredRequestIds: {},
  tabs: {},
};

export const browserDevtoolsAtom = Atom.make<BrowserDevtoolsState>({
  sessions: {},
});

const sessionData = (
  state: BrowserDevtoolsState,
  sessionId: SessionId
): SessionDevtoolsData => state.sessions[sessionId] ?? emptySessionData;

export const getTabDevtoolsData = (
  state: BrowserDevtoolsState,
  sessionId: SessionId | undefined,
  tabId: BrowserTabId | undefined
): TabDevtoolsData => {
  if (sessionId === undefined || tabId === undefined) {
    return emptyTabData;
  }
  return state.sessions[sessionId]?.tabs[tabId] ?? emptyTabData;
};

const updateSession = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  nextSession: SessionDevtoolsData
): BrowserDevtoolsState => ({
  sessions: { ...state.sessions, [sessionId]: nextSession },
});

export const appendConsoleEntry = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  entry: BrowserConsoleEntry
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
  const { tabId } = entry;
  const tab = session.tabs[tabId] ?? emptyTabData;
  return updateSession(state, sessionId, {
    ...session,
    tabs: {
      ...session.tabs,
      [tabId]: {
        ...tab,
        consoleEntries: [...tab.consoleEntries, entry].slice(
          -MAX_CONSOLE_ENTRIES
        ),
      },
    },
  });
};

export const mergeNetworkRequests = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  requests: readonly BrowserNetworkRequest[]
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
  const requestsByTab = new Map<
    BrowserTabId,
    Map<BrowserNetworkRequest["requestId"], BrowserNetworkRequest>
  >();

  for (const request of requests) {
    if (session.ignoredRequestIds[request.requestId] === true) {
      continue;
    }
    let tabRequests = requestsByTab.get(request.tabId);
    if (tabRequests === undefined) {
      tabRequests = new Map(
        (session.tabs[request.tabId]?.networkRequests ?? []).map(
          (existingRequest) => [existingRequest.requestId, existingRequest]
        )
      );
      requestsByTab.set(request.tabId, tabRequests);
    }
    tabRequests.set(request.requestId, request);
  }

  const tabs = { ...session.tabs };
  for (const [tabId, tabRequests] of requestsByTab) {
    const tab = session.tabs[tabId] ?? emptyTabData;
    tabs[tabId] = {
      ...tab,
      networkRequests: [...tabRequests.values()].slice(-MAX_NETWORK_REQUESTS),
    };
  }

  return updateSession(state, sessionId, {
    ...session,
    tabs,
  });
};

export const clearTabConsole = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  tabId: BrowserTabId
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
  const tab = session.tabs[tabId] ?? emptyTabData;
  return updateSession(state, sessionId, {
    ...session,
    tabs: {
      ...session.tabs,
      [tabId]: { ...tab, consoleEntries: [] },
    },
  });
};

export const clearTabNetwork = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  tabId: BrowserTabId
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
  const tab = session.tabs[tabId] ?? emptyTabData;
  const ignoredRequestIds = { ...session.ignoredRequestIds };
  for (const request of tab.networkRequests) {
    ignoredRequestIds[request.requestId] = true;
  }
  return updateSession(state, sessionId, {
    ...session,
    ignoredRequestIds,
    tabs: {
      ...session.tabs,
      [tabId]: { ...tab, networkRequests: [] },
    },
  });
};

export const removeSessionDevtools = (
  state: BrowserDevtoolsState,
  sessionId: SessionId
): BrowserDevtoolsState => {
  const { [sessionId]: _removed, ...sessions } = state.sessions;
  return { sessions };
};
