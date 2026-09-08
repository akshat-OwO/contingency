import { Flow as FlowSchema } from "@contingency/protocol";
import type { Flow } from "@contingency/protocol";
import { Schema } from "effect";
import { expect, it } from "vitest";

import {
  classifyStepFailure,
  flowDirectorySegment,
  flowRunsDirectory,
  hashFlow,
  runDirectoryName,
} from "../../src/services/runner";

type JsonValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

const JsonValueSchema = Schema.Union([
  Schema.Boolean,
  Schema.Null,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.suspend((): Schema.Codec<JsonValue> => JsonValueSchema)),
  Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<JsonValue> => JsonValueSchema)
  ),
]);

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reversedKeys = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map(reversedKeys);
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      right < left ? -1 : 1
    );
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, reversedKeys(entry)])
    );
  }
  return value;
};

const flow = (steps: Flow["steps"]): Flow =>
  ({ steps, title: "Any title" }) satisfies Flow;

it("hashes a Flow independently of key order", () => {
  // Two Flows that differ only in key order are the same Flow, so a Run's
  // embedded hash must not change when a serializer reorders them.
  const executed = flow([{ type: "navigate", url: "https://a.test/" }]);

  const reordered = Schema.decodeUnknownSync(FlowSchema)(
    reversedKeys(Schema.decodeUnknownSync(JsonValueSchema)(executed))
  );
  expect(hashFlow(reordered)).toBe(hashFlow(executed));
});

it("files every Run of a Flow in the directory preflight probes", () => {
  const executed = flow([{ type: "navigate", url: "https://example.com/" }]);
  Object.assign(executed, { flowId: "checkout-flow" });

  expect(flowRunsDirectory("/runs", executed)).toBe(
    `/runs/${flowDirectorySegment("checkout-flow")}`
  );
});

it("keeps a hostile Flow identity inside the output directory", () => {
  expect(flowDirectorySegment("../../escaped")).not.toContain("..");
  expect(flowDirectorySegment("../../escaped")).not.toContain("/");
  expect(flowDirectorySegment("a/b\\c")).not.toMatch(/[/\\]/u);
  // A name that sanitizes away entirely still yields a stable segment.
  expect(flowDirectorySegment("../..")).toMatch(/^flow-[a-f0-9]{16}$/u);
  expect(flowDirectorySegment("checkout-flow")).toMatch(
    /^checkout-flow-[a-f0-9]{16}$/u
  );
});

it("gives distinct Flow identities distinct directories", () => {
  // Sanitizing alone maps both of these to "a-b", which would file two
  // unrelated Flows' Runs under one history.
  expect(flowDirectorySegment("a/b")).not.toBe(flowDirectorySegment("a\\b"));

  // Truncation alone collides for identities sharing a long prefix.
  const prefix = "f".repeat(60);
  expect(flowDirectorySegment(`${prefix}-one`)).not.toBe(
    flowDirectorySegment(`${prefix}-two`)
  );
});

it("keeps Windows device names out of a directory key", () => {
  // `CON`, `PRN`, `NUL`, and `COM1`..`LPT9` cannot name a directory on
  // Windows, so a Run would execute and then fail to persist. They stay
  // reserved with an extension and in any case, so a key must never leave a
  // reserved stem before a dot.
  const reservedStems = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM9",
    "LPT1",
    "LPT9",
  ];
  const identities = reservedStems.flatMap((stem) => [
    stem,
    stem.toLowerCase(),
    `${stem}.txt`,
    `${stem.toLowerCase()}.log`,
  ]);

  for (const identity of identities) {
    const segment = flowDirectorySegment(identity);
    expect(segment).not.toBe(identity);
    // No dot means the whole segment is the stem, and it ends in the hash.
    expect(segment).not.toContain(".");
    expect(segment).toMatch(/-[a-f0-9]{16}$/u);
  }
});

it("keeps a directory key free of trailing dots and spaces", () => {
  // Windows silently strips both, which would break the mapping.
  expect(flowDirectorySegment("checkout.")).not.toMatch(/[. ]$/u);
  expect(flowDirectorySegment("checkout ")).not.toMatch(/[. ]$/u);
});

it("names a Run directory by when it started and what it is", () => {
  const startedAt = new Date("2026-08-16T11:22:33.456Z");
  const runId = "01234567-89ab-cdef-0123-456789abcdef";

  expect(runDirectoryName(startedAt, runId)).toBe("20260816T112233-01234567");
});

it("routes a failed navigation to the site and an exhausted ladder to the Flow", () => {
  expect(
    classifyStepFailure(undefined, "net::ERR_NAME_NOT_RESOLVED at x")
  ).toBe("siteError");
  // Attribution that travels on the error always wins over re-derivation.
  expect(classifyStepFailure("flowError", "net::ERR_ABORTED")).toBe(
    "flowError"
  );
  expect(
    classifyStepFailure(undefined, "Strict mode violation")
  ).toBeUndefined();
});
