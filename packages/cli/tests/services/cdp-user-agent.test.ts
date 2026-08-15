import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  navigateWithUserAgentOverride,
  platformFromUserAgent,
  userAgentMetadataFromUserAgent,
} from "../../src/services/cdp-user-agent";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState = 1;

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(value: string): void {
    this.sent.push(value);
    const message = JSON.parse(value) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    queueMicrotask(() => {
      if (message.method === "Target.getTargets") {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: message.id,
              result: {
                targetInfos: [
                  {
                    targetId: "page-1",
                    type: "page",
                    url: "https://example.com/",
                  },
                ],
              },
            }),
          })
        );
        return;
      }
      if (message.method === "Target.attachToTarget") {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: message.id,
              result: { sessionId: "session-1" },
            }),
          })
        );
        return;
      }
      if (message.method === "Page.navigate") {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: message.id,
              result: { frameId: "frame-1" },
            }),
          })
        );
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              method: "Page.loadEventFired",
              sessionId: "session-1",
            }),
          })
        );
        return;
      }
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id: message.id, result: {} }),
        })
      );
    });
  }
}

it("derives CDP platform hints from common profile user agents", () => {
  expect(
    platformFromUserAgent("Mozilla/5.0 (Linux; Android 16; Pixel 10)")
  ).toBe("Linux armv8l");
  expect(
    platformFromUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_4_1 like Mac OS X)"
    )
  ).toBe("iPhone");
  expect(
    platformFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
  ).toBe("Win32");
});

it("builds Client Hints metadata that matches mobile and desktop profiles", () => {
  const mobile = userAgentMetadataFromUserAgent(
    "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36"
  );
  expect(mobile).toMatchObject({
    mobile: true,
    model: "Pixel 10",
    platform: "Android",
    platformVersion: "16",
  });
  expect(mobile.brands.some(({ brand }) => brand === "Google Chrome")).toBe(
    true
  );

  const desktop = userAgentMetadataFromUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
  );
  expect(desktop).toMatchObject({
    mobile: false,
    platform: "Windows",
  });
});

it.effect(
  "overrides the live page user agent and navigates without launch config",
  () =>
    Effect.gen(function* verifyCdpUserAgentNavigation() {
      const socket = new FakeSocket();
      const originalWebSocket = globalThis.WebSocket;
      const FakeWebSocket = function FakeWebSocket(url: string) {
        expect(url).toBe("ws://127.0.0.1:9222/devtools/browser/test");
        queueMicrotask(() => {
          socket.dispatchEvent(new Event("open"));
        });
        return socket;
      } as unknown as typeof WebSocket;
      globalThis.WebSocket = FakeWebSocket;

      yield* Effect.ensuring(
        navigateWithUserAgentOverride({
          cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test",
          requestedTabId: "page-1",
          url: "https://www.1mg.com/",
          userAgent:
            "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
        }),
        Effect.sync(() => {
          globalThis.WebSocket = originalWebSocket;
        })
      );

      const methods = socket.sent.map(
        (payload) => (JSON.parse(payload) as { method: string }).method
      );
      expect(methods).toContain("Emulation.setUserAgentOverride");
      expect(methods).toContain("Page.navigate");
      expect(methods).not.toContain("Browser.setUserAgentOverride");

      const override = socket.sent
        .map(
          (payload) =>
            JSON.parse(payload) as {
              method: string;
              params?: {
                platform?: string;
                userAgent?: string;
                userAgentMetadata?: {
                  mobile?: boolean;
                  model?: string;
                  platform?: string;
                };
              };
            }
        )
        .find((payload) => payload.method === "Emulation.setUserAgentOverride");
      expect(override?.params?.userAgent).toContain("Android 16");
      expect(override?.params?.platform).toBe("Linux armv8l");
      expect(override?.params?.userAgentMetadata).toMatchObject({
        mobile: true,
        model: "Pixel 10",
        platform: "Android",
      });

      const navigate = socket.sent
        .map(
          (payload) =>
            JSON.parse(payload) as {
              method: string;
              params?: { url?: string };
            }
        )
        .find((payload) => payload.method === "Page.navigate");
      expect(navigate?.params?.url).toBe("https://www.1mg.com/");
    }).pipe(Effect.asVoid)
);
