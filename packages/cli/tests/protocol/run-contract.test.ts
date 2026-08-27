import type { RunEnvironment as RunEnvironmentType } from "@contingency/protocol";
import {
  axeVersionMismatchWarning,
  RunEnvironment,
} from "@contingency/protocol";
import { Result, Schema, SchemaIssue } from "effect";
import { expect, test } from "vitest";

/**
 * The Run's environment decodes strictly: an unknown field means a document
 * from another era, and ignoring it would silently drop whatever the Run
 * recorded.
 */
const decode = Schema.decodeUnknownResult(RunEnvironment, {
  onExcessProperty: "error",
});
const formatIssue = SchemaIssue.makeFormatterDefault();

const environmentWith = (extra?: Record<string, unknown>) => ({
  architecture: "arm64",
  cpuCount: 8,
  cpuModel: "Apple M2",
  loadAverage: 1.25,
  memoryBytes: 17_179_869_184,
  platform: "darwin",
  ...extra,
});

const assertDecodes = (input: unknown): RunEnvironmentType => {
  const result = decode(input);
  if (Result.isFailure(result)) {
    throw new Error(
      `Expected the environment to decode: ${formatIssue(result.failure.issue)}`
    );
  }
  return result.success;
};

test("a Run that audited nothing records no engine version", () => {
  const environment = assertDecodes(environmentWith());
  expect(environment.axeVersion).toBeUndefined();
  expect(environment.navigationReadiness).toBeUndefined();
});

test("a new Run records its bounded navigation readiness contract", () => {
  const environment = assertDecodes(
    environmentWith({
      navigationReadiness: "load-then-bounded-network-idle",
    })
  );
  expect(environment.navigationReadiness).toBe(
    "load-then-bounded-network-idle"
  );
});

test("a Run that audited something records the pinned engine version", () => {
  const environment = assertDecodes(environmentWith({ axeVersion: "4.13.0" }));
  expect(environment.axeVersion).toBe("4.13.0");
});

test("an engine version must be a non-empty string", () => {
  expect(Result.isSuccess(decode(environmentWith({ axeVersion: "" })))).toBe(
    false
  );
});

test("a comparison across an engine upgrade warns rather than refuses", () => {
  const warning = axeVersionMismatchWarning(
    assertDecodes(environmentWith({ axeVersion: "4.12.0" })),
    assertDecodes(environmentWith({ axeVersion: "4.13.0" }))
  );
  expect(warning).toContain("4.12.0");
  expect(warning).toContain("4.13.0");
});

test("the same engine, or an unrecorded one, warns nothing", () => {
  const same = assertDecodes(environmentWith({ axeVersion: "4.13.0" }));
  const unrecorded = assertDecodes(environmentWith());
  expect(axeVersionMismatchWarning(same, same)).toBeUndefined();
  expect(axeVersionMismatchWarning(unrecorded, same)).toBeUndefined();
  expect(axeVersionMismatchWarning(same, unrecorded)).toBeUndefined();
});
