import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Predicate, Schema } from "effect";
import { createEmulator } from "emulate";
import { chromium } from "playwright-core";

import { CodeExecution } from "./scripted-agent.ts";
import {
  answeredValues,
  outcomeOf,
  readTranscript,
  resolveTokens,
  substitute,
} from "./transcript.ts";
import type { ProgramOutcome, Transcript } from "./transcript.ts";

/**
 * A real Claude Code with an emulated model behind it
 * ([ADR 0090](../../../../docs/adr/0090-verification-may-emulate-the-model-behind-a-real-agent-harness.md)).
 * Claude Code registers Contingency, then `contingency start --demo` launches
 * it on the demo store. The AI service of vercel-labs/emulate answers every
 * model request, playing the `demo-interactive-run` transcript: it reads
 * getting-started, then sends each program the Scripted Agent recorded. Only
 * the model is emulated; Claude Code, the MCP server, Agent Sessions,
 * Playwright and the Workspace are real. No request leaves loopback, so the
 * run spends no model tokens.
 */

const findExecutable = (name: string) =>
  (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => path.join(directory, name))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

const CLAUDE = findExecutable("claude");
const CLI_ENTRY = path.resolve(import.meta.dirname, "../../dist/index.js");
const EXECUTE_TOOL = "mcp__contingency__agent_code_execute";
const RESOURCE_TOOL = "ReadMcpResourceTool";
const GETTING_STARTED = "contingency://docs/getting-started";
const FINAL_TEXT = "The Example Run is complete.";
const GUIDE_MISSING = "The getting-started guide was not served.";

/** What a demo session's getting-started holds: the guide and its demo procedure. */
const GUIDE_SECTIONS = [
  "# Getting started",
  "## This session",
  "### Demo onboarding",
];

/** What the cart shows when the Example Run reached its intended result. */
const CART_CONTENTS = ["Cedar Pull Saw", "Highlands, Denver"];

/**
 * A model id whose requests carry no mid-conversation `system` messages.
 * Claude Code sends those to its newer default models, and emulate 0.14.0
 * refuses them with a 400.
 */
const EMULATED_MODEL = "claude-haiku-4-5";

/** One request Claude Code sent toward the model, as the gate saw it. */
interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

const MessagesBody = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ content: Schema.Unknown, role: Schema.String })
  ),
  tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
type MessagesRequest = typeof MessagesBody.Type;

const ToolUse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literal("tool_use"),
});
const ToolResult = Schema.Struct({
  content: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
  ]),
  tool_use_id: Schema.String,
  type: Schema.Literal("tool_result"),
});

const blocksOf = (body: MessagesRequest, role: string) =>
  body.messages
    .filter((message) => message.role === role)
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : []
    );

/** The tool calls the model made so far, in order, with what each returned. */
const toolTurns = (body: MessagesRequest) => {
  const results = new Map<string, string>();
  for (const block of blocksOf(body, "user")) {
    const result = Schema.decodeUnknownOption(ToolResult)(block);
    if (result._tag === "Some") {
      const { content, tool_use_id } = result.value;
      results.set(
        tool_use_id,
        Predicate.isString(content)
          ? content
          : content.map((part) => part.text ?? "").join("")
      );
    }
  }
  return blocksOf(body, "assistant").flatMap((block) => {
    const use = Schema.decodeUnknownOption(ToolUse)(block);
    return use._tag === "Some"
      ? [{ name: use.value.name, result: results.get(use.value.id) }]
      : [];
  });
};

/** Claude Code appends its own reminders to an MCP tool's text. */
const REMINDER = /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/gu;

const decodeExecution = (text: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(CodeExecution))(
    text.replaceAll(REMINDER, "")
  );

/**
 * Plays the transcript as the model. Each main-loop request names the next
 * reply from the tool results Claude Code sent back: read getting-started,
 * then the next program with its tokens bound from earlier answers, then a
 * final message. Emulate cannot template a reply, so the gate replaces its
 * rules with that one reply before it forwards the request.
 */
const makeScript = (transcript: Transcript) => {
  const programs = transcript.steps.flatMap((step, index) =>
    step._tag === "program" ? [{ index, step }] : []
  );
  const outcomes: ProgramOutcome[] = [];
  const answers: Schema.Json[] = [];
  const nextRule = (body: MessagesRequest) =>
    Effect.gen(function* nextReply() {
      const turns = toolTurns(body);
      const guide = turns.find((turn) => turn.name === RESOURCE_TOOL);
      if (guide === undefined) {
        return {
          id: "read-getting-started",
          reply: [
            {
              arguments: { server: "contingency", uri: GETTING_STARTED },
              name: RESOURCE_TOOL,
              type: "tool_call",
            },
          ],
        };
      }
      if (!GUIDE_SECTIONS.every((section) => guide.result?.includes(section))) {
        return {
          id: "guide-missing",
          reply: [{ text: GUIDE_MISSING, type: "text" }],
        };
      }
      const executions = turns
        .filter((turn) => turn.name === EXECUTE_TOOL)
        .map((turn) => decodeExecution(turn.result ?? ""));
      const values = new Map<number, Schema.Json>();
      outcomes.length = 0;
      answers.length = 0;
      for (const [position, execution] of executions.entries()) {
        const program = programs[position];
        if (program !== undefined) {
          values.set(program.index, answeredValues(execution));
          outcomes.push(outcomeOf(execution));
          answers.push(answeredValues(execution));
        }
      }
      const next = programs[executions.length];
      if (next === undefined) {
        return { id: "report", reply: [{ text: FINAL_TEXT, type: "text" }] };
      }
      const tokens = yield* resolveTokens(transcript, {
        environment: {},
        index: next.index,
        values,
      });
      return {
        id: `program-${executions.length + 1}`,
        reply: [
          {
            arguments: { code: substitute(next.step.code, tokens) },
            name: EXECUTE_TOOL,
            type: "tool_call",
          },
        ],
      };
    });
  return { answers, nextRule, outcomes, programs };
};

const readBody = async (incoming: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    // SAFETY: a request without an encoding streams Buffers.
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

/**
 * The base URL Claude Code is given. It records every request, sets the
 * emulator's next reply for main-loop requests, and forwards each request to
 * the emulator unchanged.
 */
const modelGate = (
  emulatorUrl: string,
  script: ReturnType<typeof makeScript>
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly endpoints: Endpoint[];
      readonly server: ReturnType<typeof createServer>;
      readonly url: string;
    }>((resume) => {
      const endpoints: Endpoint[] = [];
      const upstream = new URL(emulatorUrl);
      const forward = (
        incoming: IncomingMessage,
        outgoing: ServerResponse,
        body: Buffer
      ) => {
        const sent = request(
          {
            headers: { ...incoming.headers, host: upstream.host },
            host: upstream.hostname,
            method: incoming.method,
            path: incoming.url,
            port: upstream.port,
          },
          (answer) => {
            endpoints.push({
              method: incoming.method ?? "",
              path: new URL(incoming.url ?? "/", emulatorUrl).pathname,
              status: answer.statusCode ?? 0,
            });
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(outgoing);
          }
        );
        sent.on("error", () => outgoing.destroy());
        sent.end(body);
      };
      const handle = async (
        incoming: IncomingMessage,
        outgoing: ServerResponse
      ) => {
        const body = await readBody(incoming);
        const decoded = Schema.decodeUnknownOption(
          Schema.fromJsonString(MessagesBody)
        )(body.toString("utf-8"));
        const mainLoop =
          decoded._tag === "Some" &&
          (decoded.value.tools ?? []).some(
            (tool) => tool.name === EXECUTE_TOOL
          );
        if (mainLoop) {
          const rule = await Effect.runPromise(script.nextRule(decoded.value));
          await fetch(new URL("/_ai/rules", emulatorUrl), {
            body: JSON.stringify({
              rules: [{ ...rule, match: { tool: EXECUTE_TOOL } }],
            }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          });
        }
        forward(incoming, outgoing, body);
      };
      const server = createServer((incoming, outgoing) => {
        handle(incoming, outgoing).catch(() => {
          outgoing.writeHead(500).end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        // SAFETY: a server listening on a TCP port has an AddressInfo.
        const { port } = server.address() as AddressInfo;
        resume(
          Effect.succeed({ endpoints, server, url: `http://127.0.0.1:${port}` })
        );
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      })
  );

/** Runs a command to its exit and answers with its exit code and output. */
const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
) =>
  Effect.callback<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>((resume) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) =>
      resume(Effect.succeed({ code, stderr, stdout }))
    );
    return Effect.sync(() => {
      child.kill("SIGTERM");
    });
  });

/**
 * The directory of browsers Playwright uses in this process, as Playwright
 * itself resolves it: the parent of the `chromium-<revision>` directory that
 * holds its Chromium. The private home below gets it as
 * `PLAYWRIGHT_BROWSERS_PATH`, so its processes launch the same Chromium.
 */
const browserCache = () => {
  let directory = path.dirname(chromium.executablePath());
  while (!path.basename(directory).startsWith("chromium")) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Playwright's Chromium is not in a chromium directory.");
    }
    directory = parent;
  }
  return path.dirname(directory);
};

/**
 * The environment for Contingency and Claude Code: a private home, so no
 * user Settings, Claude configuration, or Local System One is read, and the
 * gate as the model.
 */
const isolatedEnvironment = (home: string, baseUrl: string) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith("ANTHROPIC_") &&
      !name.startsWith("CLAUDE_") &&
      !name.startsWith("CONTINGENCY_") &&
      !name.startsWith("XDG_")
    ) {
      env[name] = value;
    }
  }
  return {
    ...env,
    ANTHROPIC_API_KEY: "emulated",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    DISABLE_AUTOUPDATER: "1",
    ENABLE_TOOL_SEARCH: "false",
    HOME: home,
    PLAYWRIGHT_BROWSERS_PATH: browserCache(),
    USERPROFILE: home,
  };
};

const CallRecord = Schema.Struct({
  matched: Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) })),
  path: Schema.String,
  status: Schema.Number,
});

/** Whether `file` lies inside `directory`, a filesystem root included. */
const contains = (directory: string, file: string) => {
  const relative = path.relative(directory, file);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
};

it("gives the private home the browser cache Playwright uses here", () => {
  const cache = browserCache();
  expect(path.isAbsolute(cache)).toBe(true);
  expect(contains(cache, chromium.executablePath())).toBe(true);
  const { root } = path.parse(cache);
  expect(contains(root, path.join(root, "chromium-1", "chrome"))).toBe(true);
  expect(
    contains(path.join(root, "cache"), path.join(root, "cache-other", "chrome"))
  ).toBe(false);
});

describe.skipIf(CLAUDE === undefined)(
  "Claude Code with an emulated model",
  () => {
    it.live(
      "registers Contingency, reads getting-started, and completes the demo Example Run",
      () =>
        Effect.gen(function* emulatedClaudeCode() {
          if (CLAUDE === undefined) {
            return;
          }
          if (!existsSync(CLI_ENTRY)) {
            return yield* Effect.die(
              `Build the CLI first: ${CLI_ENTRY} is missing.`
            );
          }
          const fileSystem = yield* FileSystem.FileSystem;
          const root = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "contingency-claude-code-",
          });
          const project = path.join(root, "project");
          const home = path.join(root, "home");
          yield* fileSystem.makeDirectory(project);
          yield* fileSystem.makeDirectory(path.join(home, ".claude"), {
            recursive: true,
          });
          const transcript = yield* readTranscript("demo-interactive-run");
          const script = makeScript(transcript);
          const emulator = yield* Effect.acquireRelease(
            Effect.promise(() => createEmulator({ port: 0, service: "ai" })),
            (opened) => Effect.promise(() => opened.close())
          );
          const gate = yield* modelGate(emulator.url, script);
          const env = isolatedEnvironment(home, gate.url);

          // Registration: Claude Code's own commands write and health-check it.
          const registered = yield* run(
            process.execPath,
            [CLI_ENTRY, "register", "--agent", "claude", "--scope", "project"],
            { cwd: project, env }
          );
          expect(registered.code, registered.stderr).toBe(0);
          expect(registered.stdout).toContain("Registered Contingency");
          const listed = yield* run(CLAUDE, ["mcp", "get", "contingency"], {
            cwd: project,
            env,
          });
          expect(listed.stdout).toMatch(/Status: .*Connected/u);

          // The demo launch: getting-started, then the recorded programs.
          const launched = yield* run(
            process.execPath,
            [
              CLI_ENTRY,
              "start",
              "--agent",
              "claude",
              "--demo",
              "--",
              "-p",
              "--model",
              EMULATED_MODEL,
              "--output-format",
              "json",
              "--strict-mcp-config",
              "--setting-sources",
              "",
              "--no-session-persistence",
              "--tools",
              RESOURCE_TOOL,
              "--allowedTools",
              `${EXECUTE_TOOL},${RESOURCE_TOOL}`,
            ],
            { cwd: project, env }
          );
          expect(launched.code, launched.stderr).toBe(0);
          const result = Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({ is_error: Schema.Boolean, result: Schema.String })
            )
          )(launched.stdout);
          expect(result).toEqual({ is_error: false, result: FINAL_TEXT });

          // Every program ended as it did when the Scripted Agent recorded it.
          expect(script.outcomes).toEqual(
            script.programs.map(({ step }) => step.outcome)
          );
          const cart = script.programs.findLastIndex(({ step }) =>
            step.code.includes("tools.agent_browser_snapshot(input)")
          );
          const seen = JSON.stringify(script.answers[cart] ?? null);
          for (const shown of CART_CONTENTS) {
            expect(seen).toContain(shown);
          }
          const runs = yield* fileSystem.readDirectory(
            path.join(project, "contingency"),
            { recursive: true }
          );
          expect(runs.some((entry) => entry.endsWith("summary.json"))).toBe(
            true
          );

          // The emulator answered the sequence the transcript scripts.
          const calls = Schema.decodeUnknownSync(Schema.Array(CallRecord))(
            yield* Effect.promise(() =>
              fetch(new URL("/_ai/calls", emulator.url)).then((answer) =>
                answer.json()
              )
            )
          );
          expect(
            calls.flatMap((call) =>
              call.matched?.id === undefined ? [] : [call.matched.id]
            )
          ).toEqual([
            "read-getting-started",
            ...script.programs.map((_, position) => `program-${position + 1}`),
            "report",
          ]);

          // Every endpoint the harness called, answered by the emulator.
          console.info(JSON.stringify({ endpoints: gate.endpoints }));
          for (const endpoint of gate.endpoints) {
            expect(endpoint, JSON.stringify(endpoint)).toEqual(
              endpoint.path.endsWith("/count_tokens")
                ? { ...endpoint, status: 404 }
                : { method: "POST", path: "/v1/messages", status: 200 }
            );
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      300_000
    );
  }
);
