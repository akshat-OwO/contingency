import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, describe } from "vitest";

import { readDebuggingEndpoint } from "../../src/services/debugging-endpoint.ts";

const ROUTE = "/devtools/browser/0b7f6c2e-5d1a-4f3e-9c8b-1a2b3c4d5e6f";

describe("readDebuggingEndpoint", () => {
  let directory = "";
  let file = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "contingency-endpoint-"));
    file = path.join(directory, "DevToolsActivePort");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it.effect("reads a published endpoint", () =>
    Effect.gen(function* publishedEndpoint() {
      yield* Effect.promise(() => writeFile(file, `9222\n${ROUTE}`));
      const endpoint = yield* readDebuggingEndpoint(file);
      expect(endpoint).toBe(`ws://127.0.0.1:9222${ROUTE}`);
    })
  );

  it.effect.each([
    { contents: undefined, description: "a file Chromium writes after launch" },
    {
      contents: "9222\n/devtools/",
      description: "a partly written file to complete",
    },
    {
      contents: `9222\n${ROUTE.slice(0, -8)}`,
      description: "a browser id cut off mid-write",
    },
  ])("waits for $description", ({ contents }) =>
    Effect.gen(function* completeEndpoint() {
      if (contents !== undefined) {
        yield* Effect.promise(() => writeFile(file, contents));
      }
      let polls = 0;
      const endpoint = yield* readDebuggingEndpoint(file, undefined, () =>
        Effect.gen(function* publishEndpoint() {
          polls += 1;
          yield* TestClock.adjust(25);
          yield* Effect.promise(() => writeFile(file, `9222\n${ROUTE}`));
        })
      );
      expect(endpoint).toBe(`ws://127.0.0.1:9222${ROUTE}`);
      expect(polls).toBe(1);
    })
  );

  it.effect.each([
    {
      contents: "9222\n/devtools/browser/not-a-uuid",
      description: "a browser id that is not a UUID",
    },
    {
      contents: "not-a-port\n/elsewhere",
      description: "contents that can never be an endpoint",
    },
  ])("fails without polling on $description", ({ contents }) =>
    Effect.gen(function* invalidEndpoint() {
      yield* Effect.promise(() => writeFile(file, contents));
      let polls = 0;
      const result = yield* Effect.result(
        readDebuggingEndpoint(file, undefined, () =>
          Effect.sync(() => {
            polls += 1;
          })
        )
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: new Error("Chromium published an invalid debugging endpoint."),
      });
      expect(polls).toBe(0);
    })
  );

  it.effect("reports a file that never appears", () =>
    Effect.gen(function* endpointDeadline() {
      const result = yield* Effect.result(
        readDebuggingEndpoint(file, 100, TestClock.adjust)
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: new Error("Chromium did not publish its debugging endpoint."),
      });
    })
  );

  it.effect("reports a file that never completes", () =>
    Effect.gen(function* endpointDeadline() {
      yield* Effect.promise(() => writeFile(file, "9222\n"));
      const result = yield* Effect.result(
        readDebuggingEndpoint(file, 100, TestClock.adjust)
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: new Error(
          "Chromium published an incomplete debugging endpoint."
        ),
      });
    })
  );
});
