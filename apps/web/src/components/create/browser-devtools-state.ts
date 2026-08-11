import type {
  BrowserConsoleEntry,
  BrowserNetworkRequest,
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
  readonly requestOwners: Readonly<Record<string, string>>;
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
  requestOwners: {},
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
  tabId: string | undefined
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
  tabId: string,
  entry: BrowserConsoleEntry
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
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
  activeTabId: string,
  requests: readonly BrowserNetworkRequest[]
): BrowserDevtoolsState => {
  const session = sessionData(state, sessionId);
  const requestOwners = { ...session.requestOwners };
  const tabRequests = new Map(
    (session.tabs[activeTabId]?.networkRequests ?? []).map((request) => [
      request.requestId,
      request,
    ])
  );

  for (const request of requests) {
    const owner = requestOwners[request.requestId] ?? activeTabId;
    requestOwners[request.requestId] = owner;
    if (
      owner === activeTabId &&
      session.ignoredRequestIds[request.requestId] !== true
    ) {
      tabRequests.set(request.requestId, request);
    }
  }

  const tab = session.tabs[activeTabId] ?? emptyTabData;
  return updateSession(state, sessionId, {
    ...session,
    requestOwners,
    tabs: {
      ...session.tabs,
      [activeTabId]: {
        ...tab,
        networkRequests: [...tabRequests.values()].slice(-MAX_NETWORK_REQUESTS),
      },
    },
  });
};

export const clearTabConsole = (
  state: BrowserDevtoolsState,
  sessionId: SessionId,
  tabId: string
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
  tabId: string
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
