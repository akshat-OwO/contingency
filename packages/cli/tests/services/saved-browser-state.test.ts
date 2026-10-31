import type { TeachingEvent } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  matchesRequiredModification,
  readBrowserState,
  stampBrowserState,
} from "../../src/services/saved-browser-state.ts";

it.effect(
  "replaces all saved cookie and header literals and reuses a session Variable",
  () =>
    Effect.gen(function* savedVariables() {
      const events: TeachingEvent[] = [
        {
          _tag: "browser-modification",
          actor: "agent",
          at: "2026-01-01T00:00:00.000Z",
          command: JSON.stringify({
            action: "cookie_set",
            cookie: {
              domain: "example.com",
              httpOnly: false,
              name: "session",
              path: "/",
              secure: false,
              value: "cookie-literal",
            },
            operationId: "cookie",
          }),
          description: "cookie",
          id: "cookie",
          seq: 1,
          url: "https://example.com",
          variableNames: { COOKIE_session: "ACCOUNT_TOKEN" },
        },
        {
          _tag: "browser-modification",
          actor: "agent",
          at: "2026-01-01T00:00:00.000Z",
          command: JSON.stringify({
            action: "headers_set",
            headers: { "x-auth": "header-literal" },
            operationId: "headers",
          }),
          description: "headers",
          id: "headers",
          seq: 2,
          url: "https://example.com",
        },
      ];
      const files = yield* stampBrowserState(
        [
          {
            content:
              "---\nname: test\ndescription: Test\ninputs:\n---\ncookie-literal",
            path: "SKILL.md",
          },
          {
            content: '{"value":"header-literal"}',
            path: "references/notes.json",
          },
        ],
        events
      );
      expect(JSON.stringify(files)).not.toContain("cookie-literal");
      expect(JSON.stringify(files)).not.toContain("header-literal");
      expect(files[0]?.content).toContain("ACCOUNT_TOKEN");
      const required = yield* readBrowserState(files);
      const [, header] = required;
      if (header === undefined) {
        return yield* Effect.die("Missing header");
      }
      const command = {
        action: "headers_set",
        headers: { "x-auth": "fresh-value" },
        operationId: "fresh",
      } as const;
      expect(matchesRequiredModification(header, command, [])).toBe(false);
      expect(
        matchesRequiredModification(header, command, [], () => "wrong")
      ).toBe(false);
      expect(
        matchesRequiredModification(header, command, [], (name) =>
          name === "HEADER_X_AUTH" ? "fresh-value" : undefined
        )
      ).toBe(true);
    })
);
