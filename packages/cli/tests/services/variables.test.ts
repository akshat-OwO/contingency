import type { Flow, Variable } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Redacted } from "effect";

import type { ResolveVariablesOptions } from "../../src/services/variables";
import {
  parseSecretFlag,
  preflight,
  redactSecrets,
  substituteVariables,
  variableEnvironmentName,
} from "../../src/services/variables";

const writableFileSystem = FileSystem.layerNoop({
  access: () => Effect.void,
  makeDirectory: () => Effect.void,
});

const unwritableFileSystem = FileSystem.layerNoop({
  makeDirectory: () => Effect.die(new Error("EACCES: permission denied")),
});

// A recursive create succeeds on a directory that already exists, whatever
// its permissions, so this models the case preflight must still catch.
const existingUnwritableFileSystem = FileSystem.layerNoop({
  access: () => Effect.die(new Error("EACCES: permission denied")),
  makeDirectory: () => Effect.void,
});

const flowWith = (variables: readonly Variable[]): Flow =>
  ({
    contingency: { variables },
    steps: [{ type: "navigate", url: "https://example.com/" }],
    title: "Sign in",
  }) as Flow;

const neverPrompt = () => Effect.die(new Error("Prompted unexpectedly"));

type PreflightOptions = ResolveVariablesOptions<never>;

const options = (
  overrides: Partial<PreflightOptions> = {}
): PreflightOptions => ({
  environment: {},
  interactive: false,
  outputDirectory: "/runs",
  prompt: neverPrompt,
  retriesEnabled: false,
  secrets: [],
  ...overrides,
});

it("parses both forms of the secret flag", () => {
  expect(parseSecretFlag("TOKEN=abc")).toEqual({ name: "TOKEN", value: "abc" });
  expect(parseSecretFlag("TOKEN")).toEqual({ name: "TOKEN", value: undefined });
  // Only the first separator delimits the name, so a value may contain "=".
  expect(parseSecretFlag("TOKEN=a=b=c")).toEqual({
    name: "TOKEN",
    value: "a=b=c",
  });
  // An empty value is still a supplied value, distinct from a bare name.
  expect(parseSecretFlag("TOKEN=")).toEqual({ name: "TOKEN", value: "" });
  expect(parseSecretFlag("=orphan")).toBeUndefined();
  expect(parseSecretFlag("   ")).toBeUndefined();
});

it.effect("supplies a Variable from NAME=value", () =>
  Effect.gen(function* supplyInline() {
    const report = yield* preflight(
      flowWith([{ name: "PASSWORD", runtime: false, secret: true }]),
      options({ secrets: ["PASSWORD=hunter2"] })
    );

    expect(report.resolution.values.get("PASSWORD")).toBe("hunter2");
    expect(report.resolution.secretNames.has("PASSWORD")).toBe(true);
  }).pipe(Effect.provide(writableFileSystem))
);

it.effect(
  "reads a bare NAME from the environment, keeping it out of argv",
  () =>
    Effect.gen(function* supplyFromEnvironment() {
      const report = yield* preflight(
        flowWith([{ name: "PASSWORD", runtime: false, secret: true }]),
        options({
          environment: { [variableEnvironmentName("PASSWORD")]: "from-env" },
          secrets: ["PASSWORD"],
        })
      );

      expect(report.resolution.values.get("PASSWORD")).toBe("from-env");
    }).pipe(Effect.provide(writableFileSystem))
);

it.effect(
  "fails when the environment variable behind a bare NAME is unset",
  () =>
    Effect.gen(function* missingEnvironment() {
      const failure = yield* Effect.flip(
        preflight(
          flowWith([{ name: "PASSWORD", runtime: false, secret: true }]),
          options({ secrets: ["PASSWORD"] })
        )
      );

      expect(failure.message).toContain("CONTINGENCY_SECRET_PASSWORD");
    }).pipe(Effect.provide(writableFileSystem))
);

it.effect(
  "prompts for a runtime Variable when the terminal is interactive",
  () =>
    Effect.gen(function* promptWhenInteractive() {
      const prompted: string[] = [];
      const report = yield* preflight(
        flowWith([{ name: "OTP", runtime: true, secret: true }]),
        options({
          interactive: true,
          prompt: (variable) => {
            prompted.push(variable.name);
            return Effect.succeed(Redacted.make("123456"));
          },
        })
      );

      expect(prompted).toEqual(["OTP"]);
      expect(report.resolution.values.get("OTP")).toBe("123456");
    }).pipe(Effect.provide(writableFileSystem))
);

it.effect("never prompts without an interactive terminal", () =>
  Effect.gen(function* failFastWhenUnattended() {
    // `neverPrompt` dies if called, so reaching the failure proves no prompt.
    const failure = yield* Effect.flip(
      preflight(
        flowWith([{ name: "OTP", runtime: true, secret: true }]),
        options({ interactive: false })
      )
    );

    expect(failure.message).toContain("no interactive terminal");
  }).pipe(Effect.provide(writableFileSystem))
);

it.effect("reports every problem at once", () =>
  Effect.gen(function* reportAllProblems() {
    const failure = yield* Effect.flip(
      preflight(
        flowWith([
          { name: "PASSWORD", runtime: false, secret: true },
          { name: "USERNAME", runtime: false, secret: false },
          { name: "OTP", runtime: true, secret: true },
        ]),
        options()
      )
    );

    // One invocation, one complete list — not one problem per attempt.
    expect(failure.problems).toHaveLength(3);
    expect(failure.message).toContain("PASSWORD");
    expect(failure.message).toContain("USERNAME");
    expect(failure.message).toContain("OTP");
  }).pipe(Effect.provide(writableFileSystem))
);

it.effect("reports an unwritable output directory alongside Variables", () =>
  Effect.gen(function* reportOutputProblem() {
    const failure = yield* Effect.flip(
      preflight(
        flowWith([{ name: "PASSWORD", runtime: false, secret: true }]),
        options()
      )
    );

    expect(failure.problems).toHaveLength(2);
    expect(failure.message).toContain("/runs");
  }).pipe(Effect.provide(unwritableFileSystem))
);

it.effect("rejects an existing output directory that cannot be written", () =>
  Effect.gen(function* reportExistingUnwritable() {
    const failure = yield* Effect.flip(preflight(flowWith([]), options()));

    expect(failure.problems).toHaveLength(1);
    expect(failure.message).toContain("/runs");
  }).pipe(Effect.provide(existingUnwritableFileSystem))
);

it.effect("warns that a single-use code cannot survive a retry", () =>
  Effect.gen(function* warnOnRetryableSecret() {
    const report = yield* preflight(
      flowWith([{ name: "OTP", runtime: true, secret: true }]),
      options({ retriesEnabled: true, secrets: ["OTP=123456"] })
    );

    expect(report.warnings.join("\n")).toContain("--retry 0");
  }).pipe(Effect.provide(writableFileSystem))
);

it.effect("does not warn about a single-use code when retries are off", () =>
  Effect.gen(function* noWarningWithoutRetries() {
    const report = yield* preflight(
      flowWith([{ name: "OTP", runtime: true, secret: true }]),
      options({ retriesEnabled: false, secrets: ["OTP=123456"] })
    );

    expect(report.warnings).toEqual([]);
  }).pipe(Effect.provide(writableFileSystem))
);

it.effect("warns about a supplied Variable the Flow never declares", () =>
  Effect.gen(function* warnOnUnknownSecret() {
    const report = yield* preflight(
      flowWith([{ name: "PASSWORD", runtime: false, secret: true }]),
      options({ secrets: ["PASSWORD=hunter2", "TYPO=value"] })
    );

    expect(report.warnings.join("\n")).toContain("TYPO");
  }).pipe(Effect.provide(writableFileSystem))
);

it("substitutes references and leaves undeclared ones intact", () => {
  const values = new Map([["PASSWORD", "hunter2"]]);

  expect(substituteVariables("{{PASSWORD}}", values)).toBe("hunter2");
  expect(substituteVariables("a{{PASSWORD}}b", values)).toBe("ahunter2b");
  // An undeclared reference stays literal rather than becoming an empty
  // string, so a typo is visible instead of submitted to a form.
  expect(substituteVariables("{{MISSING}}", values)).toBe("{{MISSING}}");
});

it("redacts secret values from text bound for the Run", () => {
  const resolution = {
    secretNames: new Set(["PASSWORD"]),
    values: new Map([
      ["PASSWORD", "hunter2"],
      ["REGION", "eu-west"],
    ]),
  };

  expect(redactSecrets("Element not found for value hunter2", resolution)).toBe(
    "Element not found for value {{PASSWORD}}"
  );
  // A Variable that is not secret is not redacted; it is not sensitive.
  expect(redactSecrets("region eu-west", resolution)).toBe("region eu-west");
});

it("redacts overlapping secret values in either declaration order", () => {
  // Replacing SHORT first would turn "abc123456" into "{{SHORT}}123456",
  // persisting the sensitive tail, so the longest value must go first.
  const shortFirst = {
    secretNames: new Set(["SHORT", "LONG"]),
    values: new Map([
      ["SHORT", "abc"],
      ["LONG", "abc123456"],
    ]),
  };
  const longFirst = {
    secretNames: new Set(["SHORT", "LONG"]),
    values: new Map([
      ["LONG", "abc123456"],
      ["SHORT", "abc"],
    ]),
  };

  for (const resolution of [shortFirst, longFirst]) {
    const redacted = redactSecrets("value abc123456 here", resolution);
    expect(redacted).toBe("value {{LONG}} here");
    expect(redacted).not.toContain("123456");
  }

  // The shorter value alone still redacts.
  expect(redactSecrets("value abc here", shortFirst)).toBe(
    "value {{SHORT}} here"
  );
});
