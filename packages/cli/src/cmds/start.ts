import path from "node:path";

import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../package.json" with { type: "json" };
import {
  AGENT_PROFILES,
  AgentLaunchError,
  agentArguments,
  currentInvocation,
  demoInitialMessage,
  detectAgent,
  olderThan,
  reconnectCommand,
  registrationCommand,
  sessionServerSpec,
  workInitialMessage,
} from "../services/agent-launch.ts";
import type { DetectedAgent } from "../services/agent-launch.ts";
import { REGISTERED_AGENTS } from "../services/catalog-directory.ts";
import type { RegisteredAgent } from "../services/catalog-directory.ts";
import { CATALOG_DIRECTORY } from "../services/flow-skill-catalog.ts";

const missingAgentsMessage = (): string =>
  [
    "Contingency onboarding needs Claude Code or Codex, installed and signed in.",
    ...REGISTERED_AGENTS.map(
      (agent) =>
        `- ${AGENT_PROFILES[agent].label}: ${AGENT_PROFILES[agent].install}`
    ),
    "Then run `npx @contingencyhq/cli start` again.",
  ].join("\n");

const unavailable = (
  agent: RegisteredAgent,
  detected: Option.Option<DetectedAgent>
) => {
  const profile = AGENT_PROFILES[agent];
  if (Option.isNone(detected)) {
    return `${profile.label} is not installed or not on PATH. ${profile.install}`;
  }
  return `${profile.label} is installed but not signed in. ${profile.signIn}`;
};

/**
 * Choose the agent: the explicit `--agent`, the one usable agent, or a picker
 * when both are usable. A missing or signed-out agent is reported with the
 * step that fixes it.
 */
const chooseAgent = (requested: Option.Option<RegisteredAgent>) =>
  Effect.gen(function* choose() {
    const detected = {
      claude: yield* detectAgent("claude", process.env.PATH),
      codex: yield* detectAgent("codex", process.env.PATH),
    };
    if (Option.isSome(requested)) {
      const found = detected[requested.value];
      if (Option.isNone(found) || !found.value.signedIn) {
        return yield* Effect.fail(
          new AgentLaunchError({ message: unavailable(requested.value, found) })
        );
      }
      return found.value;
    }
    const usable = REGISTERED_AGENTS.flatMap((agent) => {
      const found = detected[agent];
      return Option.isSome(found) && found.value.signedIn ? [found.value] : [];
    });
    const [first, second] = usable;
    if (first === undefined) {
      const installed = REGISTERED_AGENTS.filter((agent) =>
        Option.isSome(detected[agent])
      );
      return yield* Effect.fail(
        new AgentLaunchError({
          message:
            installed.length === 0
              ? missingAgentsMessage()
              : installed
                  .map((agent) => unavailable(agent, detected[agent]))
                  .join("\n"),
        })
      );
    }
    if (second === undefined) {
      return first;
    }
    if (!process.stdin.isTTY) {
      return yield* Effect.fail(
        new AgentLaunchError({
          message:
            "Claude Code and Codex are both installed. Choose one with --agent claude or --agent codex.",
        })
      );
    }
    return yield* Prompt.run(
      Prompt.Select({
        choices: usable.map((agent) => ({
          title: agent.profile.label,
          value: agent,
        })),
        message: "Which agent should run Contingency onboarding?",
      })
    ).pipe(
      Effect.mapError(
        () => new AgentLaunchError({ message: "No agent was chosen." })
      )
    );
  });

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
    agent: Flag.Literals("agent", REGISTERED_AGENTS).pipe(
      Flag.withDescription(
        "The agent to launch. Without it, the one installed agent starts, or a picker appears when both are installed."
      ),
      Flag.optional
    ),
    agentArgs: Argument.String("agent-args").pipe(
      Argument.withDescription(
        "Extra arguments for the agent, after --, such as `exec` for a non-interactive Codex run."
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
    const chosen = yield* chooseAgent(agent);
    const invocation = currentInvocation({
      execPath: process.execPath,
      packageName: packageJson.name,
      script: process.argv[1] ?? "",
      version: packageJson.version,
    });
    const spec = sessionServerSpec({
      agent: chosen.profile.id,
      demo,
      directory,
      invocation,
    });
    yield* Console.error(
      [
        `Starting ${chosen.profile.label}${chosen.version === undefined ? "" : ` ${chosen.version}`} with Contingency connected for this session${demo ? " and the bundled demo store" : ""}.`,
        `Catalog Root: ${catalogRoot}`,
      ].join("\n")
    );
    if (
      chosen.version !== undefined &&
      olderThan(chosen.version, chosen.profile.verifiedVersion)
    ) {
      yield* Console.error(
        `This release was verified with ${chosen.profile.label} ${chosen.profile.verifiedVersion}. If onboarding fails, update ${chosen.profile.label} and try again.`
      );
    }
    const message = demo
      ? demoInitialMessage({
          agent: chosen.profile,
          catalogRoot,
          directory,
          registrationCommand: registrationCommand({
            agent: chosen.profile.id,
            directory,
            invocation,
          }),
        })
      : workInitialMessage({
          agent: chosen.profile,
          catalogRoot,
          directory,
          reconnectCommand: reconnectCommand({
            agent: chosen.profile.id,
            invocation,
          }),
        });
    const args = agentArguments({
      agent: chosen.profile.id,
      extra: agentArgs,
      message,
      spec,
    });
    const code = yield* Effect.scoped(
      Effect.gen(function* runAgent() {
        yield* holdSignals;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(
          ChildProcess.make(chosen.executable, args, {
            cwd: directory,
            // The agent shares this terminal's process group, so it can read
            // the keyboard and receive Ctrl-C itself.
            detached: false,
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
            message: `${chosen.profile.label} could not start: ${cause.message}`,
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
    "Launch Claude Code or Codex with Contingency connected for this session only. Add --demo for guided onboarding on the bundled demo store."
  )
);
