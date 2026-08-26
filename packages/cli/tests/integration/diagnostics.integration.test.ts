import { readFile } from "node:fs/promises";

import type { Flow } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

/**
 * A failing Step is only worth as much as what it says about the failure. The
 * assertions here are on the persisted Run rather than on the Runner's return
 * value: a diagnostic nobody can read after the Run has ended is not one.
 */

/** Short, so a Step that is meant to fail does not spend ten seconds doing it. */
const MISS_TIMEOUT_MS = 1500;

it.live(
  "reports every candidate a failed Step tried, and why each missed",
  () =>
    Effect.gen(function* reportEveryCandidate() {
      const fixtures = yield* fixtureServer;

      const { persisted } = yield* runFlow(
        flow([
          { type: "navigate", url: fixtures.url("renamed.html") },
          {
            target: [
              // Gone: the button this Flow was authored against was renamed.
              { kind: "role", name: "Place order", role: "button" },
              // Two of these, so the Flow does not say which.
              { kind: "css", selector: ".remove" },
              // There, and never visible.
              { kind: "css", selector: "#saved-for-later" },
              { expression: "//button[@id='order']", kind: "xpath" },
            ],
            timeout: MISS_TIMEOUT_MS,
            type: "click",
          },
        ])
      );

      expect(persisted.outcome).toBe("failed");
      expect(persisted.failure?.kind).toBe("flowError");

      const diagnostics = persisted.steps[1]?.selector;
      // Every candidate, not only the last: a Flow author needs to know which
      // strategies broke and which were never reached.
      expect(
        diagnostics?.candidates.map((candidate) => candidate.strategy)
      ).toEqual(["role", "css", "css", "xpath"]);
      // Absent and ambiguous are the pair the previous runtime could not tell
      // apart, and the pair that decides which repair a Flow needs.
      expect(
        diagnostics?.candidates.map((candidate) => candidate.miss)
      ).toEqual(["absent", "ambiguous", "hidden", "absent"]);
      expect(diagnostics?.candidates[1]?.matches).toBe(2);
      // In words rather than as a raw path.
      expect(diagnostics?.candidates[0]?.lookedFor).toBe(
        'role button named "Place order"'
      );

      // The rename is visible as a rename: the button is right there under its
      // new name, which "not found" on its own never shows.
      expect(
        diagnostics?.nearest?.some(
          (element) =>
            element.role === "button" && element.name === "Place your order"
        )
      ).toBe(true);

      // And the same evidence reaches a reader who only sees the message.
      expect(persisted.failure?.message).toContain("(tried 4)");
      expect(persisted.failure?.message).toContain("Place your order");
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("stops the Run when a candidate fails for reasons of its own", () =>
  Effect.gen(function* stopOnBrowserFailure() {
    const fixtures = yield* fixtureServer;

    const { persisted } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("renamed.html") },
        {
          // Not a selector the page can answer at all: an invalid expression
          // is the browser refusing the question, not the page missing an
          // element. The Run stops rather than recording a miss and moving on.
          target: [
            { expression: "//button[", kind: "xpath" },
            { kind: "css", selector: "#checkout" },
          ],
          timeout: MISS_TIMEOUT_MS,
          type: "click",
        },
      ])
    );

    expect(persisted.outcome).toBe("failed");
    // No diagnostic: nothing here is evidence about the selector ladder, and
    // recording it as one would blame the Flow for a broken question.
    expect(persisted.steps[1]?.selector).toBeUndefined();
    expect(persisted.failure?.kind).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("scrubs a secret the page echoed out of every failure artifact", () =>
  Effect.gen(function* scrubSecrets() {
    const fixtures = yield* fixtureServer;
    const secret = "hunter2-correct-horse";

    const { directory, persisted } = yield* runFlow(
      {
        ...flow([
          { type: "navigate", url: fixtures.url("secret-echo.html") },
          // The page puts this into visible text, so it is now part of what a
          // diagnostic would report as a nearby element.
          {
            target: [{ kind: "css", selector: "#token" }],
            type: "change",
            value: "{{TOKEN}}",
          },
          // And now a Step that cannot resolve, which is what produces the
          // diagnostic that would have printed it.
          {
            target: [{ kind: "css", selector: "#no-such-button" }],
            timeout: MISS_TIMEOUT_MS,
            type: "click",
          },
        ]),
        variables: [{ name: "TOKEN", runtime: false, secret: true }],
      } as Flow,
      {
        variables: {
          secretNames: new Set(["TOKEN"]),
          values: new Map([["TOKEN", secret]]),
        },
      }
    );

    expect(persisted.outcome).toBe("failed");
    // The diagnostic did report the echoed text — otherwise this test would
    // pass by reporting nothing at all.
    expect(
      persisted.steps[2]?.selector?.nearest?.some((element) =>
        element.name.includes("{{TOKEN}}")
      )
    ).toBe(true);
    // And the whole artifact, not only the field this test happened to read.
    const contents = yield* Effect.promise(() =>
      readFile(`${directory}/run.json`, "utf-8")
    );
    expect(contents).not.toContain(secret);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
