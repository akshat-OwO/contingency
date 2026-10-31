import type { TeachingEvent } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { validateFlowSkillPackage } from "../../src/services/flow-skill-package.ts";
import {
  browserVariableReference,
  matchesRequiredModification,
  readBrowserState,
  stampBrowserState,
} from "../../src/services/saved-browser-state.ts";

it.effect(
  "parameterizes saved cookie and header values and reuses a session Variable",
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
              "---\nname: test\ndescription: Test\ninputs:\n---\n\n1. Open the fixture. Done when: fixture is visible.",
            path: "SKILL.md",
          },
          {
            content: '{"count":1}',
            path: "references/notes.json",
          },
        ],
        events
      );
      expect(files[1]?.content).toBe('{"count":1}');
      const rejected = yield* Effect.flip(
        stampBrowserState(
          [{ content: "---\ninputs:\n---\ncookie-literal", path: "SKILL.md" }],
          events
        )
      );
      expect(rejected.message).toContain("ACCOUNT_TOKEN");
      const shortEvents = events.slice(0, 1).map((event) => ({
        ...event,
        command: JSON.stringify({
          action: "cookie_set",
          cookie: {
            domain: "example.com",
            httpOnly: false,
            name: "flag",
            path: "/",
            secure: false,
            value: "1",
          },
          operationId: "short",
        }),
      }));
      const shortFiles = yield* stampBrowserState(
        files.slice(0, 2),
        shortEvents
      );
      expect(shortFiles[0]?.content).toContain("1. Open the fixture.");
      expect(
        Result.isSuccess(validateFlowSkillPackage("test", shortFiles))
      ).toBe(true);
      expect(shortFiles[1]?.content).toBe('{"count":1}');
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

it("assigns stable names, reserves collisions, and reuses Variables", () => {
  const reference = browserVariableReference(
    new Set(["COOKIE_QA"]),
    new Map([["known-value", "ACCOUNT_TOKEN"]])
  );
  expect(reference("known-value", "COOKIE_qa")).toBe("{{ACCOUNT_TOKEN}}");
  expect(reference("first", "COOKIE_qa")).toBe("{{COOKIE_QA_2}}");
  expect(reference("second", "COOKIE_qa")).toBe("{{COOKIE_QA_3}}");
  expect(reference("first", "HEADER_other")).toBe("{{COOKIE_QA_2}}");
});
