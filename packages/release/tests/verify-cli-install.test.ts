import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  isServerNotification,
  parseNpmPackOutput,
  runInstallCheckCommand,
} from "../src/verify-cli-install.ts";

const entry = {
  filename: "contingencyhq-cli-0.3.4-alpha.4.tgz",
  name: "@contingencyhq/cli",
};

describe("npm pack output", () => {
  for (const [version, value] of [
    ["11", [entry]],
    ["12", { "@contingencyhq/cli": entry }],
  ] as const) {
    it.effect(`reads npm ${version} stdout with separate stderr`, () =>
      Effect.gen(function* test() {
        const filename = yield* parseNpmPackOutput({
          stderr: "npm notice package details\n",
          stdout: JSON.stringify(value),
        });
        expect(filename).toBe(entry.filename);
      })
    );
  }

  for (const value of [
    [],
    {},
    [entry, entry],
    [{ ...entry, filename: "../cli.tgz" }],
  ]) {
    it.effect(
      `rejects invalid artifact metadata ${JSON.stringify(value)}`,
      () =>
        Effect.gen(function* test() {
          const result = yield* Effect.result(
            parseNpmPackOutput({ stderr: "", stdout: JSON.stringify(value) })
          );
          expect(result._tag).toBe("Failure");
        })
    );
  }

  it.effect("preserves stdout and stderr in decode errors", () =>
    Effect.gen(function* test() {
      const result = yield* Effect.result(
        parseNpmPackOutput({
          stderr: "npm diagnostic",
          stdout: '{"error":"pack failed"}',
        })
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("pack failed");
        expect(result.failure.message).toContain("npm diagnostic");
      }
    })
  );
});

describe("install check command", () => {
  it.effect("collects JSON stdout without mixing stderr", () =>
    Effect.gen(function* test() {
      const output = yield* runInstallCheckCommand(
        process.execPath,
        ["-e", 'process.stdout.write("[]"); process.stderr.write("notice");'],
        process.cwd()
      );
      expect(output).toStrictEqual({ stderr: "notice", stdout: "[]" });
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("fails on a successful command with ERESOLVE on stderr", () =>
    Effect.gen(function* test() {
      const result = yield* Effect.result(
        runInstallCheckCommand(
          process.execPath,
          [
            "-e",
            'process.stderr.write("ERESOLVE overriding peer dependency");',
          ],
          process.cwd()
        )
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(String(result.failure)).toContain("ERESOLVE");
      }
    }).pipe(Effect.provide(NodeServices.layer))
  );
});

describe("packed MCP output", () => {
  it("skips server notifications and keeps responses", () => {
    expect(
      isServerNotification(
        '{"jsonrpc":"2.0","method":"notifications/prompts/list_changed","params":{}}'
      )
    ).toBe(true);
    expect(
      isServerNotification('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}')
    ).toBe(false);
    expect(
      isServerNotification('{"jsonrpc":"2.0","id":3,"method":"ping"}')
    ).toBe(false);
    expect(isServerNotification("not json")).toBe(false);
  });
});
