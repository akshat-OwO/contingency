import type {
  TeachingBrowserAttachment,
  AgentSessionId,
  BrowserCookieWrite,
  BrowserRequestId,
  BrowserNetworkRequestDetail,
  BrowserStorageSnapshot,
  BrowserTabId,
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
 * without the browser handle they run against. The Workspace addresses an
 * Agent Session, whose lower-level browser handle never leaves the server
 * process (ADR 0038); the panels only ever see this port.
 */
export interface BrowserTooling {
  readonly attachBrowserContext?:
    | ((attachment: TeachingBrowserAttachment) => void)
    | undefined;
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

/** Browser setup against the MCP-owned browser an Agent Session holds. */
export const useAgentBrowserTooling = (
  sessionId: AgentSessionId
): BrowserTooling => {
  const {
    agentBrowserNetworkRequestGetMutation,
    agentBrowserStorageClearMutation,
    agentBrowserStorageDeleteMutation,
    agentBrowserStorageGetMutation,
    agentBrowserStorageSetMutation,
  } = useRpcDependencies();
  const getNetworkRequest = useAtomSet(agentBrowserNetworkRequestGetMutation, {
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
        payload: { kind, sessionId, tabId },
      });
    },
    deleteStorage: async (tabId, input) => {
      await deleteStorage({
        payload: { ...input, sessionId, tabId },
      });
    },
    getNetworkRequest: async (tabId, requestId) => {
      const result = await getNetworkRequest({
        payload: { requestId, sessionId, tabId },
      });
      return result.request;
    },
    getStorage: async (tabId, kind) => {
      const result = await getStorage({
        payload: { kind, sessionId, tabId },
      });
      return result.snapshot;
    },
    setStorage: async (tabId, input) => {
      await setStorage({
        payload: { ...input, sessionId, tabId },
      });
    },
  };
};
