import type {
  BrowserNetworkRequest,
  BrowserRequestId,
  BrowserTabId,
  SessionId,
} from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  getTabDevtoolsData,
  mergeNetworkRequests,
} from "../../../src/components/create/browser-devtools-state";

describe("mergeNetworkRequests", () => {
  it("attributes requests to their originating tab after the active tab changes", () => {
    const request = {
      headers: {},
      method: "GET",
      requestId: "request-1" as BrowserRequestId,
      resourceType: "Document",
      status: 200,
      tabId: "t1" as BrowserTabId,
      timestamp: 1,
      url: "https://example.com",
    };
    const state = mergeNetworkRequests(
      { sessions: {} },
      "create-review" as SessionId,
      [request] satisfies readonly BrowserNetworkRequest[]
    );

    expect(
      getTabDevtoolsData(
        state,
        "create-review" as SessionId,
        "t1" as BrowserTabId
      ).networkRequests
    ).toHaveLength(1);
    expect(
      getTabDevtoolsData(
        state,
        "create-review" as SessionId,
        "t2" as BrowserTabId
      ).networkRequests
    ).toHaveLength(0);
  });
});
