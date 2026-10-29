import type { BrowserNetworkRequestDetail } from "@contingency/protocol";
import { BrowserRequestId, BrowserTabId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import {
  boundedDevtoolsText,
  DEVTOOLS_LIMITS,
  filterDevtoolsRequests,
  redactDevtoolsRequest,
} from "../../src/services/browser-devtools.ts";

it("keeps journey credentials and transport encodings while bounding bodies", () => {
  const secret = 'private +"value"';
  const result = redactDevtoolsRequest(
    {
      headers: {
        Authorization: secret,
        Cookie: "opaque-cookie",
        "Proxy-Authorization": "opaque-proxy",
        "x-private": encodeURIComponent(secret),
      },
      method: "POST",
      postData: new URLSearchParams({ value: secret }).toString(),
      requestId: BrowserRequestId.make("request"),
      resourceType: "fetch",
      responseBody:
        JSON.stringify({ value: secret }) +
        "x".repeat(DEVTOOLS_LIMITS.bodyBytes),
      responseHeaders: { "Set-Cookie": "opaque-response-cookie" },
      tabId: BrowserTabId.make("tab"),
      timestamp: 0,
      url: `https://example.test/?secret=${encodeURIComponent(secret)}`,
    },
    [secret]
  );
  expect(result.headers.Authorization).toBe(secret);
  expect(result.headers.Cookie).toBe("opaque-cookie");
  expect(result.headers["Proxy-Authorization"]).toBe("opaque-proxy");
  expect(result.responseHeaders?.["Set-Cookie"]).toBe("opaque-response-cookie");
  expect(JSON.stringify(result)).toContain("opaque");
  expect(JSON.stringify(result)).toContain(encodeURIComponent(secret));
  expect(result.responseBody).toContain(JSON.stringify(secret).slice(1, -1));
  expect(result.bodyTruncated).toBe(true);
  expect(Buffer.byteLength(result.responseBody ?? "")).toBeLessThanOrEqual(
    DEVTOOLS_LIMITS.bodyBytes
  );
  expect(boundedDevtoolsText("€".repeat(100), [], 4)).toEqual({
    text: "€",
    truncated: true,
  });
});

it("filters requests on literal metadata and returns projections without headers or bodies", () => {
  const secret = "token-value";
  const request = (
    id: string,
    overrides: Partial<BrowserNetworkRequestDetail>
  ): BrowserNetworkRequestDetail => ({
    headers: { Authorization: `Bearer ${secret}` },
    method: "GET",
    postData: "body",
    requestId: BrowserRequestId.make(id),
    resourceType: "fetch",
    responseBody: "response",
    responseHeaders: { "Set-Cookie": "opaque" },
    status: 200,
    tabId: BrowserTabId.make("tab"),
    timestamp: 0,
    url: `https://example.test/api?token=${secret}`,
    ...overrides,
  });
  const result = filterDevtoolsRequests(
    {
      dropped: 7,
      requests: [
        request("ok", {}),
        request("post", { method: "POST", status: 500 }),
        request("doc", {
          resourceType: "document",
          url: "https://example.test/",
        }),
      ],
    },
    { action: "requests", method: "get", statusMax: 299, url: "/api" },
    [secret]
  );
  expect(result.dropped).toBe(7);
  expect(result.requests.map((item) => item.requestId)).toEqual(["ok"]);
  const [projected] = result.requests;
  expect(projected).not.toHaveProperty("headers");
  expect(projected).not.toHaveProperty("postData");
  expect(projected).not.toHaveProperty("responseBody");
  expect(projected).not.toHaveProperty("responseHeaders");
  expect(JSON.stringify(result)).toContain(secret);
});
