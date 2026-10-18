import { BrowserRequestId, BrowserTabId } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";

import {
  boundedDevtoolsText,
  DEVTOOLS_LIMITS,
  redactDevtoolsRequest,
} from "../../src/services/browser-devtools.ts";

it("masks all credential headers and scrubs transport encodings before bounding bodies", () => {
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
  expect(result.headers.Authorization).toBe("[redacted]");
  expect(result.headers.Cookie).toBe("[redacted]");
  expect(result.headers["Proxy-Authorization"]).toBe("[redacted]");
  expect(result.responseHeaders?.["Set-Cookie"]).toBe("[redacted]");
  expect(JSON.stringify(result)).not.toContain("opaque");
  expect(JSON.stringify(result)).not.toContain(encodeURIComponent(secret));
  expect(result.responseBody).not.toContain(
    JSON.stringify(secret).slice(1, -1)
  );
  expect(result.bodyTruncated).toBe(true);
  expect(Buffer.byteLength(result.responseBody ?? "")).toBeLessThanOrEqual(
    DEVTOOLS_LIMITS.bodyBytes
  );
  expect(boundedDevtoolsText("€".repeat(100), [], 4)).toEqual({
    text: "€",
    truncated: true,
  });
});
