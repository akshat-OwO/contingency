import type { BrowserNetworkRequest } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  getTabDevtoolsData,
  mergeNetworkRequests,
} from "../../../src/components/browser/browser-devtools-state";

describe("mergeNetworkRequests", () => {
  it("attributes requests to their originating tab after the active tab changes", () => {
    const request = {
      headers: {},
      method: "GET",
      requestId: "request-1",
      resourceType: "Document",
      status: 200,
      tabId: "t1",
      timestamp: 1,
      url: "https://example.com",
    };
    const state = mergeNetworkRequests({ sessions: {} }, "create-review", [
      request,
    ] satisfies readonly BrowserNetworkRequest[]);

    expect(
      getTabDevtoolsData(state, "create-review", "t1").networkRequests
    ).toHaveLength(1);
    expect(
      getTabDevtoolsData(state, "create-review", "t2").networkRequests
    ).toHaveLength(0);
  });
});
