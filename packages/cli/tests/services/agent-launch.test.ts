import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Result } from "effect";

import {
  AgentHarnesses,
  HARNESS_IDS,
  olderThan,
} from "../../src/services/agent-harness.ts";
import type {
  AgentHarness,
  HarnessId,
  HarnessReadiness,
  LaunchRequest,
} from "../../src/services/agent-harness.ts";
import { AgentHarnessesLive } from "../../src/services/agent-harnesses.ts";
import {
  chooseHarness,
  currentInvocation,
  demoInitialMessage,
  reconnectCommand,
  registrationCommand,
  sessionServerSpec,
  shellQuote,
  workInitialMessage,
} from "../../src/services/agent-launch.ts";
import type {
  ReadyHarness,
  AgentLaunchError,
} from "../../src/services/agent-launch.ts";

const invocation = currentInvocation({
  execPath: "/usr/local/bin/node",
  packageName: "@contingencyhq/cli",
  script: "/opt/contingency/dist/index.js",
  version: "1.2.3",
});
const spec = sessionServerSpec({
  agent: "claude",
  demo: false,
  directory: "/work/my app",
  invocation,
});

it("supplies a session-only server on an available port for this directory", () => {
  expect(spec).toEqual({
    args: [
      "/opt/contingency/dist/index.js",
      "mcp",
      "--agent",
      "claude",
      "--fallback-directory",
      "/work/my app",
    ],
    command: "/usr/local/bin/node",
    env: {
      CONTINGENCY_CATALOG_ROOT: "/work/my app/.contingency",
      CONTINGENCY_MCP_PORT: "0",
    },
  });
});

it("serves the demo store only to a session started with --demo", () => {
  expect(
    sessionServerSpec({
      agent: "claude",
      demo: true,
      directory: "/work/my app",
      invocation,
    }).args
  ).toEqual([
    "/opt/contingency/dist/index.js",
    "mcp",
    "--agent",
    "claude",
    "--fallback-directory",
    "/work/my app",
    "--demo",
  ]);
});

it("re-invokes an npx run through npx at the same version", () => {
  expect(
    currentInvocation({
      execPath: "/usr/local/bin/node",
      packageName: "@contingencyhq/cli",
      script:
        "/Users/a/.npm/_npx/abc/node_modules/@contingencyhq/cli/dist/index.js",
      version: "1.2.3",
    })
  ).toEqual({ args: ["-y", "@contingencyhq/cli@1.2.3"], command: "npx" });
});

/** The launch plan the real harness builds. */
const launchPlan = (harness: HarnessId, request: LaunchRequest) =>
  Effect.gen(function* buildPlan() {
    const harnesses = yield* AgentHarnesses;
    return yield* harnesses[harness].launchPlan(request);
  }).pipe(
    Effect.provide(AgentHarnessesLive),
    Effect.provide(NodeServices.layer)
  );

it.effect(
  "passes Claude Code its MCP config and ends the variadic option before the prompt",
  () =>
    Effect.gen(function* claudePlan() {
      const plan = yield* launchPlan("claude", {
        executable: "/bin/claude",
        extra: ["-p"],
        message: "hello",
        spec,
      });
      expect(plan.command).toBe("/bin/claude");
      expect(plan.env).toEqual({});
      const { args } = plan;
      expect(args.slice(0, 2)).toEqual(["-p", "--mcp-config"]);
      expect(JSON.parse(args[2] ?? "")).toEqual({
        mcpServers: {
          contingency: {
            args: spec.args,
            command: spec.command,
            env: spec.env,
            type: "stdio",
          },
        },
      });
      expect(args.slice(3)).toEqual(["--", "hello"]);
      // Nothing that changes permissions, models, or authentication.
      expect(args.join(" ")).not.toMatch(
        /permission|allowedTools|--model|dangerously|strict-mcp-config/u
      );
    })
);

it.effect("passes Codex TOML overrides and keeps the prompt last", () =>
  Effect.gen(function* codexPlan() {
    const codex = sessionServerSpec({
      agent: "codex",
      demo: false,
      directory: "/work/app",
      invocation,
    });
    const plan = yield* launchPlan("codex", {
      executable: "/bin/codex",
      extra: ["exec"],
      message: "hello",
      spec: codex,
    });
    expect(plan).toEqual({
      args: [
        "-c",
        'mcp_servers.contingency.command="/usr/local/bin/node"',
        "-c",
        'mcp_servers.contingency.args=["/opt/contingency/dist/index.js", "mcp", "--agent", "codex", "--fallback-directory", "/work/app"]',
        "-c",
        'mcp_servers.contingency.env={ CONTINGENCY_CATALOG_ROOT = "/work/app/.contingency", CONTINGENCY_MCP_PORT = "0" }',
        "-c",
        "mcp_servers.contingency.startup_timeout_sec=60",
        "exec",
        "hello",
      ],
      command: "/bin/codex",
      env: {},
    });
  })
);

it("points the first message at the bundled prompt and the launch context", () => {
  const message = demoInitialMessage({
    agent: { label: "Claude Code" },
    catalogRoot: "/work/my app/.contingency",
    directory: "/work/my app",
    registrationCommand: registrationCommand({
      agent: "claude",
      directory: "/work/my app",
      invocation,
    }),
  });
  expect(message).toContain("contingency://onboarding/starter-prompt");
  expect(message).toContain("- Catalog Root: /work/my app/.contingency");
  expect(message).toContain(
    "/usr/local/bin/node /opt/contingency/dist/index.js register --agent claude --fallback-directory '/work/my app'"
  );
});

it("points a work session at the work prompt and how to reconnect", () => {
  const message = workInitialMessage({
    agent: { label: "Codex" },
    catalogRoot: "/work/my app/.contingency",
    directory: "/work/my app",
    reconnectCommand: reconnectCommand({ agent: "codex", invocation }),
  });
  expect(message).toContain("contingency://start/work-prompt");
  expect(message).not.toContain("contingency://onboarding/starter-prompt");
  expect(message).not.toContain("register");
  expect(message).toContain("- Catalog Root: /work/my app/.contingency");
  expect(message).toContain(
    "/usr/local/bin/node /opt/contingency/dist/index.js start --agent codex"
  );
});

it("quotes shell words and compares versions", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellQuote("/plain/path")).toBe("/plain/path");
  expect(olderThan("2.1.200", "2.1.289")).toBe(true);
  expect(olderThan("0.160.0", "0.160.0")).toBe(false);
  expect(olderThan("0.161.0", "0.160.0")).toBe(false);
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * A PATH holding one executable per harness binary. Each prints its
 * `--version` line and records every argument vector it receives.
 */
const withExecutables = <A, E>(
  versions: Readonly<Record<string, string>>,
  body: (input: {
    readonly calls: Effect.Effect<string, unknown, FileSystem.FileSystem>;
    readonly pathVariable: string;
  }) => Effect.Effect<A, E, AgentHarnesses | FileSystem.FileSystem>
) =>
  Effect.gen(function* prepareExecutables() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-harness-path-",
    });
    const log = path.join(directory, "calls.log");
    for (const [binary, version] of Object.entries(versions)) {
      const executable = path.join(directory, binary);
      yield* fileSystem.writeFileString(
        executable,
        `#!/bin/sh\necho "${binary} $*" >> '${log}'\necho '${version}'\n`
      );
      yield* fileSystem.chmod(executable, 0o755);
    }
    return yield* body({
      calls: fileSystem.readFileString(log),
      pathVariable: directory,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(AgentHarnessesLive),
    Effect.provide(NodeServices.layer)
  );

const readiness = (harness: HarnessId, pathVariable: string) =>
  Effect.gen(function* readHarness() {
    const harnesses = yield* AgentHarnesses;
    return yield* harnesses[harness].readiness(pathVariable);
  });

it.effect("is ready from the executable and its version alone", () =>
  withExecutables(
    { claude: "2.1.296 (Claude Code)", codex: "codex-cli 0.162.1" },
    ({ calls, pathVariable }) =>
      Effect.gen(function* readyHarnesses() {
        expect(yield* readiness("claude", pathVariable)).toEqual({
          _tag: "ready",
          executable: path.join(pathVariable, "claude"),
          version: "2.1.296",
        });
        expect(yield* readiness("codex", pathVariable)).toEqual({
          _tag: "ready",
          executable: path.join(pathVariable, "codex"),
          version: "0.162.1",
        });
        // No authentication probe and no model prompt.
        expect((yield* calls).trim().split("\n").toSorted()).toEqual([
          "claude --version",
          "codex --version",
        ]);
      })
  )
);

it.effect("is not installed when the executable is not on PATH", () =>
  withExecutables({}, ({ pathVariable }) =>
    Effect.gen(function* missingHarnesses() {
      for (const harness of HARNESS_IDS) {
        expect(yield* readiness(harness, pathVariable)).toEqual({
          _tag: "not-installed",
        });
      }
    })
  )
);

it.effect(
  "is unsupported when --version names another product or major version",
  () =>
    withExecutables(
      { claude: "3.0.0 (Claude Code)", codex: "some-other-codex 0.162.1" },
      ({ pathVariable }) =>
        Effect.gen(function* unsupportedHarnesses() {
          expect(yield* readiness("claude", pathVariable)).toEqual({
            _tag: "unsupported",
            executable: path.join(pathVariable, "claude"),
            reported: "3.0.0 (Claude Code)",
          });
          expect(yield* readiness("codex", pathVariable)).toEqual({
            _tag: "unsupported",
            executable: path.join(pathVariable, "codex"),
            reported: "some-other-codex 0.162.1",
          });
        })
    )
);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const READY = (id: HarnessId): HarnessReadiness => ({
  _tag: "ready",
  executable: `/bin/${id}`,
  version: "1.0.0",
});
const NOT_INSTALLED: HarnessReadiness = { _tag: "not-installed" };

const fakeHarness = (
  id: HarnessId,
  readinessResult: HarnessReadiness
): AgentHarness => ({
  currentProjectDirectory: ({ cwd }) => Effect.succeed(cwd),
  id,
  install: `Install ${id}.`,
  label: `Harness ${id}`,
  launchPlan: (request) =>
    Effect.succeed({ args: [], command: request.executable, env: {} }),
  readiness: () => Effect.succeed(readinessResult),
  register: () => Effect.die(new Error("not used by selection")),
  registrationServerSpec: () => ({ args: [], command: id, env: {} }),
  verifiedVersion: "1.0.0",
});

const fakeHarnesses = (
  readinessById: Readonly<Record<HarnessId, HarnessReadiness>>
) =>
  Layer.succeed(AgentHarnesses, {
    claude: fakeHarness("claude", readinessById.claude),
    codex: fakeHarness("codex", readinessById.codex),
  });

const choose = (
  readinessById: Readonly<Record<HarnessId, HarnessReadiness>>,
  options: {
    readonly pick?: (
      ready: readonly ReadyHarness[]
    ) => Effect.Effect<ReadyHarness, AgentLaunchError>;
    readonly requested?: HarnessId;
  } = {}
) =>
  chooseHarness({
    pathVariable: undefined,
    pick: Option.fromUndefinedOr(options.pick),
    requested: Option.fromUndefinedOr(options.requested),
  }).pipe(Effect.provide(fakeHarnesses(readinessById)), Effect.result);

const failureMessage = (
  result: Result.Result<ReadyHarness, AgentLaunchError>
): string => (Result.isFailure(result) ? result.failure.message : "no failure");

it.effect("gives install guidance for every harness when none is ready", () =>
  Effect.gen(function* noneReady() {
    const message = failureMessage(
      yield* choose({ claude: NOT_INSTALLED, codex: NOT_INSTALLED })
    );
    expect(message).toContain(
      "Contingency onboarding needs Harness claude or Harness codex."
    );
    for (const id of HARNESS_IDS) {
      expect(message).toContain(`- Harness ${id}: Install ${id}.`);
    }
    expect(message).not.toMatch(/sign/iu);
  })
);

it.effect("refuses an unsupported harness with install guidance", () =>
  Effect.gen(function* unsupportedOnly() {
    const message = failureMessage(
      yield* choose({
        claude: {
          _tag: "unsupported",
          executable: "/bin/claude",
          reported: "9.0.0",
        },
        codex: NOT_INSTALLED,
      })
    );
    expect(message).toBe(
      'Harness claude at /bin/claude reports "9.0.0", which this release does not support. Install claude.'
    );
  })
);

it.effect("launches the one ready harness directly", () =>
  Effect.gen(function* oneReady() {
    const result = yield* choose(
      { claude: NOT_INSTALLED, codex: READY("codex") },
      { pick: () => Effect.die(new Error("no picker for one harness")) }
    );
    expect(Result.isSuccess(result) && result.success.harness.id).toBe("codex");
  })
);

it.effect("lets the user pick among several ready harnesses", () =>
  Effect.gen(function* severalReady() {
    let offered: readonly HarnessId[] = [];
    const result = yield* choose(
      { claude: READY("claude"), codex: READY("codex") },
      {
        pick: (ready) =>
          Effect.gen(function* pickLast() {
            offered = ready.map((entry) => entry.harness.id);
            const last = ready.at(-1);
            return last ?? (yield* Effect.die(new Error("nothing offered")));
          }),
      }
    );
    expect(offered).toEqual([...HARNESS_IDS]);
    expect(Result.isSuccess(result) && result.success.harness.id).toBe("codex");
  })
);

it.effect(
  "names every --agent value when several are ready and no picker is available",
  () =>
    Effect.gen(function* nonInteractive() {
      const message = failureMessage(
        yield* choose({ claude: READY("claude"), codex: READY("codex") })
      );
      expect(message).toBe(
        "Harness claude and Harness codex are installed. Choose one with --agent claude or --agent codex."
      );
      for (const id of HARNESS_IDS) {
        expect(message).toContain(`--agent ${id}`);
      }
    })
);

it.effect("refuses an explicit --agent that is not ready", () =>
  Effect.gen(function* explicitUnready() {
    const message = failureMessage(
      yield* choose(
        { claude: NOT_INSTALLED, codex: READY("codex") },
        { requested: "claude" }
      )
    );
    expect(message).toBe(
      "Harness claude is not installed or not on PATH. Install claude."
    );
  })
);

it.effect("launches an explicit --agent that is ready", () =>
  Effect.gen(function* explicitReady() {
    const result = yield* choose(
      { claude: READY("claude"), codex: READY("codex") },
      { requested: "claude" }
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      executable: "/bin/claude",
      harness: expect.objectContaining({ id: "claude" }),
      version: "1.0.0",
    });
  })
);
