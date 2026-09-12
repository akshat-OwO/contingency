import type {
  AgentSessionId,
  BrowserCookieWrite,
  BrowserRequestId,
  BrowserNetworkRequestDetail,
  BrowserStorageSnapshot,
  BrowserTabId,
  SessionId,
  StorageKind,
} from "@contingency/protocol";
import { useAtomSet } from "@effect/atom-react";

import { useRpcDependencies } from "@/lib/rpc-dependencies";

/** One write to a tab's storage, addressed by the store it belongs to. */
export type StorageWrite =
  | { readonly cookie: BrowserCookieWrite; readonly kind: "cookies" }
  | {
      readonly key: string;
      readonly kind: "local" | "session";
      readonly value: string;
    };

/** One entry to remove, identified the way its own store identifies it. */
export type StorageErase =
  | {
      readonly domain: string;
      readonly kind: "cookies";
      readonly name: string;
      readonly path: string;
    }
  | { readonly key: string; readonly kind: "local" | "session" };

/**
 * The browser setup operations the storage and devtools panels need, named
 * without the browser handle they run against. Create View addresses a generic
 * browser session directly; the Workspace addresses an Agent Session, whose
 * lower-level browser handle never leaves the server process (ADR 0038). The
 * panels are the same either way because they only ever see this port.
 */
export interface BrowserTooling {
  readonly clearStorage: (
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Promise<void>;
  readonly deleteStorage: (
    tabId: BrowserTabId,
    input: StorageErase
  ) => Promise<void>;
  readonly getNetworkRequest: (
    tabId: BrowserTabId,
    requestId: BrowserRequestId
  ) => Promise<BrowserNetworkRequestDetail>;
  readonly getStorage: (
    tabId: BrowserTabId,
    kind: StorageKind
  ) => Promise<BrowserStorageSnapshot>;
  readonly setStorage: (
    tabId: BrowserTabId,
    input: StorageWrite
  ) => Promise<void>;
}

/** Browser setup against a generic browser session, as Create View drives it. */
export const useSessionBrowserTooling = (
  sessionId: SessionId
): BrowserTooling => {
  const {
    browserNetworkRequestMutation,
    browserStorageClearMutation,
    browserStorageDeleteMutation,
    browserStorageGetMutation,
    browserStorageSetMutation,
  } = useRpcDependencies();
  const getNetworkRequest = useAtomSet(browserNetworkRequestMutation, {
    mode: "promise",
  });
  const clearStorage = useAtomSet(browserStorageClearMutation, {
    mode: "promise",
  });
  const deleteStorage = useAtomSet(browserStorageDeleteMutation, {
    mode: "promise",
  });
  const getStorage = useAtomSet(browserStorageGetMutation, {
    mode: "promise",
  });
  const setStorage = useAtomSet(browserStorageSetMutation, {
    mode: "promise",
  });
  return {
    clearStorage: async (tabId, kind) => {
      await clearStorage({
        payload: {
          data: { kind, sessionId, tabId },
          type: "browser.storage.clear",
        },
      });
    },
    deleteStorage: async (tabId, input) => {
      await deleteStorage({
        payload: {
          data: { ...input, sessionId, tabId },
          type: "browser.storage.delete",
        },
      });
    },
    getNetworkRequest: async (tabId, requestId) => {
      const result = await getNetworkRequest({
        payload: {
          data: { requestId, sessionId, tabId },
          type: "browser.network.request.get",
        },
      });
      return result.data.request;
    },
    getStorage: async (tabId, kind) => {
      const result = await getStorage({
        payload: {
          data: { kind, sessionId, tabId },
          type: "browser.storage.get",
        },
      });
      return result.data.snapshot;
    },
    setStorage: async (tabId, input) => {
      await setStorage({
        payload: {
          data: { ...input, sessionId, tabId },
          type: "browser.storage.set",
        },
      });
    },
  };
};

/** Browser setup against the MCP-owned browser an Agent Session holds. */
export const useAgentBrowserTooling = (
  sessionId: AgentSessionId
): BrowserTooling => {
  const {
    agentBrowserNetworkRequestMutation,
    agentBrowserStorageClearMutation,
    agentBrowserStorageDeleteMutation,
    agentBrowserStorageGetMutation,
    agentBrowserStorageSetMutation,
  } = useRpcDependencies();
  const getNetworkRequest = useAtomSet(agentBrowserNetworkRequestMutation, {
    mode: "promise",
  });
  const clearStorage = useAtomSet(agentBrowserStorageClearMutation, {
    mode: "promise",
  });
  const deleteStorage = useAtomSet(agentBrowserStorageDeleteMutation, {
    mode: "promise",
  });
  const getStorage = useAtomSet(agentBrowserStorageGetMutation, {
    mode: "promise",
  });
  const setStorage = useAtomSet(agentBrowserStorageSetMutation, {
    mode: "promise",
  });
  return {
    clearStorage: async (tabId, kind) => {
      await clearStorage({
        payload: {
          data: { kind, sessionId, tabId },
          type: "agent.browser.storage.clear",
        },
      });
    },
    deleteStorage: async (tabId, input) => {
      await deleteStorage({
        payload: {
          data: { ...input, sessionId, tabId },
          type: "agent.browser.storage.delete",
        },
      });
    },
    getNetworkRequest: async (tabId, requestId) => {
      const result = await getNetworkRequest({
        payload: {
          data: { requestId, sessionId, tabId },
          type: "agent.browser.network.request.get",
        },
      });
      return result.data.request;
    },
    getStorage: async (tabId, kind) => {
      const result = await getStorage({
        payload: {
          data: { kind, sessionId, tabId },
          type: "agent.browser.storage.get",
        },
      });
      return result.data.snapshot;
    },
    setStorage: async (tabId, input) => {
      await setStorage({
        payload: {
          data: { ...input, sessionId, tabId },
          type: "agent.browser.storage.set",
        },
      });
    },
  };
};
