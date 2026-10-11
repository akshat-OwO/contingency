import path from "node:path";

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import { HARNESS_IDS, olderThan } from "../services/agent-harness.ts";
import { AgentLaunchError } from "../services/agent-launch-error.ts";
import {
  chooseHarness,
  currentInvocation,
  demoInitialMessage,
  reconnectCommand,
  registrationCommand,
  sessionServerSpec,
  workInitialMessage,
} from "../services/agent-launch.ts";
import type { ReadyHarness } from "../services/agent-launch.ts";
import { CATALOG_DIRECTORY } from "../services/flow-skill-catalog.ts";

const pickHarness = (ready: readonly ReadyHarness[]) =>
  Prompt.run(
    Prompt.Select({
      choices: ready.map((entry) => ({
        title: entry.harness.label,
        value: entry,
      })),
      message: "Which agent should run Contingency onboarding?",
    })
  ).pipe(
    Effect.mapError(
      () => new AgentLaunchError({ message: "No agent was chosen." })
    )
  );

/**
 * While the agent owns the terminal, Ctrl-C belongs to it: the agent handles
 * its own interrupts and exits, and this process follows it out. Signals are
 * swallowed here only until the agent exits. SIGTERM still interrupts the
 * launcher and finalizes its child when only the launcher is targeted.
 */
const ignoreSignal = (): void => {
  // The agent in the foreground receives the same signal and decides.
};

const holdSignals = Effect.acquireRelease(
  Effect.sync(() => {
    const previous = {
      SIGINT: process.listeners("SIGINT"),
    };
    process.removeAllListeners("SIGINT");
    process.on("SIGINT", ignoreSignal);
    return previous;
  }),
  (previous) =>
    Effect.sync(() => {
      process.removeAllListeners("SIGINT");
      for (const listener of previous.SIGINT) {
        process.on("SIGINT", listener);
      }
    })
);

export const startCommand = Command.make(
  "start",
  {
    agent: Flag.Literals("agent", HARNESS_IDS).pipe(
      Flag.withDescription(
        "The agent to launch. Without it, the one installed agent starts, or a picker appears when several are installed."
      ),
      Flag.optional
    ),
    agentArgs: Argument.String("agent-args").pipe(
      Argument.withDescription(
        "Extra arguments for the agent, after --, such as `exec` for a non-interactive Codex run. OpenCode refuses --server, because a shared server never sees the session-only connection."
      ),
      Argument.variadic()
    ),
    demo: Flag.Boolean("demo").pipe(
      Flag.withDescription(
        "Run guided onboarding on the bundled Ridgeline Hardware demo store. Without it, the agent works on your own website with no demo store."
      ),
      Flag.withDefault(false)
    ),
  },
  Effect.fnUntraced(function* runStart({ agent, agentArgs, demo }) {
    const directory = path.resolve(process.cwd());
    const catalogRoot = path.join(directory, CATALOG_DIRECTORY);
    const chosen = yield* chooseHarness({
      pathVariable: process.env.PATH,
      pick: process.stdin.isTTY ? Option.some(pickHarness) : Option.none(),
      requested: agent,
    });
    const invocation = currentInvocation({
      execPath: process.execPath,
      packageName: packageJson.name,
      script: process.argv[1] ?? "",
      version: packageJson.version,
    });
    const spec = sessionServerSpec({
      agent: chosen.harness.id,
      demo,
      directory,
      invocation,
    });
    const message = demo
      ? demoInitialMessage({
          agent: chosen.harness,
          catalogRoot,
          directory,
          registrationCommand: registrationCommand({
            agent: chosen.harness.id,
            directory,
            invocation,
          }),
        })
      : workInitialMessage({
          agent: chosen.harness,
          catalogRoot,
          directory,
          reconnectCommand: reconnectCommand({
            agent: chosen.harness.id,
            invocation,
          }),
        });
    const plan = yield* chosen.harness.launchPlan({
      env: process.env,
      executable: chosen.executable,
      extra: agentArgs,
      message,
      spec,
    });
    yield* Console.error(
      [
        `Starting ${chosen.harness.label} ${chosen.version} with Contingency connected for this session${demo ? " and the bundled demo store" : ""}.`,
        `Catalog Root: ${catalogRoot}`,
      ].join("\n")
    );
    if (olderThan(chosen.version, chosen.harness.verifiedVersion)) {
      yield* Console.error(
        `This release was verified with ${chosen.harness.label} ${chosen.harness.verifiedVersion}. If onboarding fails, update ${chosen.harness.label} and try again.`
      );
    }
    const code = yield* Effect.scoped(
      Effect.gen(function* runAgent() {
        yield* holdSignals;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(plan.command, [...plan.args], {
            cwd: directory,
            // The agent shares this terminal's process group, so it can read
            // the keyboard and receive Ctrl-C itself.
            detached: false,
            env: { ...plan.env },
            extendEnv: true,
            stderr: "inherit",
            stdin: "inherit",
            stdout: "inherit",
          })
        );
        return yield* handle.exitCode;
      })
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AgentLaunchError({
            message: `${chosen.harness.label} could not start: ${cause.message}`,
          })
      )
    );
    if (code !== 0) {
      yield* Effect.sync(() => {
        process.exitCode = code;
      });
    }
  })
).pipe(
  Command.withDescription(
    "Launch Claude Code, Codex, or OpenCode with Contingency connected for this session only. Add --demo for guided onboarding on the bundled demo store."
  )
);
