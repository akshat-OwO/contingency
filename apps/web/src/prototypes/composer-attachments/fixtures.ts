import {
  AgentSessionSnapshot,
  BrowserNetworkRequest,
  BrowserTabId,
} from "@contingency/protocol";
import type {
  BrowserNetworkRequestDetail,
  BrowserStorageSnapshot,
} from "@contingency/protocol";
import { Schema } from "effect";

import type { BrowserTooling } from "@/components/browser/browser-tooling";

import { requests, storageItems } from "./model";

/**
 * PROTOTYPE ONLY. Protocol-shaped mocks, decoded through the real schemas so
 * the production dock and devtools render them exactly as they would a live
 * session.
 */

const startedAt = "2026-10-04T11:00:00.000Z";
const startedMs = Date.parse(startedAt);

export const mockTabId = Schema.decodeUnknownSync(BrowserTabId)("tab-mock");
export const mockTabUrl = "https://shop.local/checkout/confirmation";

export const mockSession = Schema.decodeUnknownSync(AgentSessionSnapshot)({
  activity: "teaching",
  captureState: { _tag: "recording", startedAt },
  clientName: "Prototype",
  clientVersion: "0",
  controller: "user",
  createdAt: startedAt,
  currentUrl: mockTabUrl,
  flowSkillName: "checkout",
  id: "agent-prototype",
  interruptedAction: null,
  ownerProcessId: "prototype",
  phase: "running",
  recordingId: "recording-prototype",
  run: null,
  takeover: null,
  teaching: { actionCount: 3, instructionCount: 0, instructions: [] },
  timeline: [],
  updatedAt: startedAt,
  verification: null,
  viewUrl: "http://localhost/",
});

export const mockNetworkRequests = Schema.decodeUnknownSync(
  Schema.Array(BrowserNetworkRequest)
)(
  requests.map((request) => ({
    headers: { accept: "application/json" },
    method: request.method,
    mimeType: "application/json",
    requestId: request.id,
    resourceType: request.type,
    responseHeaders: { "content-type": "application/json" },
    status: request.status,
    tabId: "tab-mock",
    timestamp: startedMs + request.offsetMs,
    url: request.url,
  }))
);

const storageSnapshot = (
  kind: BrowserStorageSnapshot["kind"]
): BrowserStorageSnapshot => {
  if (kind === "cookies") {
    return {
      cookies: storageItems.flatMap((item) =>
        item.area === "cookie"
          ? [
              {
                domain: "shop.local",
                expires: -1,
                httpOnly: true,
                name: item.key,
                path: "/",
                secure: true,
                session: true,
                size: item.key.length + item.value.length,
                value: item.value,
              },
            ]
          : []
      ),
      kind,
      tabId: mockTabId,
    };
  }
  const area = kind === "local" ? "local" : "session";
  return {
    entries: Object.fromEntries(
      storageItems.flatMap((item) =>
        item.area === area ? [[item.key, item.value] as const] : []
      )
    ),
    kind,
    tabId: mockTabId,
  };
};

const detailOf = (requestId: string): BrowserNetworkRequestDetail => {
  const request = mockNetworkRequests.find(
    (item) => item.requestId === requestId
  );
  if (request === undefined) {
    throw new Error(`No mock request ${requestId}`);
  }
  return {
    ...request,
    responseBody: requests.find((item) => item.id === requestId)?.body,
  };
};

/** Read-only tooling over the mocks. Writes are refused, never applied. */
export const mockTooling: BrowserTooling = {
  clearStorage: () =>
    Promise.reject(new Error("The prototype does not change storage.")),
  deleteStorage: () =>
    Promise.reject(new Error("The prototype does not change storage.")),
  getNetworkRequest: (_tabId, requestId) =>
    Promise.resolve(detailOf(requestId)),
  getStorage: (_tabId, kind) => Promise.resolve(storageSnapshot(kind)),
  setStorage: () =>
    Promise.reject(new Error("The prototype does not change storage.")),
};
