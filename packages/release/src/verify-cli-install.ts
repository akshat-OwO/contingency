import path from "node:path";

import {
  Console,
  Effect,
  FileSystem,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const PackEntry = Schema.Struct({
  filename: Schema.String,
  name: Schema.Literal("@contingencyhq/cli"),
});
const PackResult = Schema.Union([
  Schema.Array(PackEntry),
  Schema.Record(Schema.String, PackEntry),
]);

/** npm 11 emits an array; npm 12 emits a record keyed by package name. */
export const parseNpmPackOutput = Effect.fn("parseNpmPackOutput")(
  function* parse(output: {
    readonly stdout: string;
    readonly stderr: string;
  }) {
    const decoded = yield* Effect.try({
      catch: (cause) =>
        new Error(
          `Invalid npm pack stdout:\n${output.stdout.slice(0, 2000)}\nStderr:\n${output.stderr}`,
          { cause }
        ),
      try: () =>
        Schema.decodeUnknownSync(PackResult)(JSON.parse(output.stdout)),
    });
    const entries = Object.values(decoded);
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      return yield* Effect.fail(
        new Error("npm pack must return exactly one CLI tarball")
      );
    }
    if (
      path.basename(entry.filename) !== entry.filename ||
      !entry.filename.endsWith(".tgz")
    ) {
      return yield* Effect.fail(
        new Error(`Invalid npm pack filename: ${entry.filename}`)
      );
    }
    return entry.filename;
  }
);
const InitializeResponse = Schema.Struct({
  id: Schema.Literal(1),
  result: Schema.Struct({
    capabilities: Schema.Unknown,
    protocolVersion: Schema.String,
    serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
  }),
});
/** The packed docs ship beside the bundle and are served as resources. */
const DocsResponse = Schema.Struct({
  id: Schema.Literal(2),
  result: Schema.Struct({
    contents: Schema.Tuple([
      Schema.Struct({
        text: Schema.String.check(Schema.isStartingWith("<!-- Generated")),
        uri: Schema.Literal("contingency://docs/settings"),
      }),
    ]),
  }),
});

/** The packed interpreter process runs a program that calls the server. */
const InterpreterResponse = Schema.Struct({
  id: Schema.Literal(3),
  result: Schema.Struct({
    isError: Schema.Literal(false),
    structuredContent: Schema.Struct({
      receipts: Schema.Tuple([
        Schema.Struct({
          operation: Schema.Literal("agent_sessions_get"),
          outcome: Schema.Literal("succeeded"),
        }),
      ]),
      status: Schema.Literal("completed"),
      value: Schema.Literal(0),
    }),
  }),
});

/** The packed process starts with its V8 heap ceiling, and is held to it. */
const InterpreterCeilingResponse = Schema.Struct({
  id: Schema.Literal(4),
  result: Schema.Struct({
    isError: Schema.Literal(false),
    structuredContent: Schema.Struct({
      diagnostic: Schema.Struct({
        kind: Schema.Literal("MemoryLimitExceeded"),
      }),
      status: Schema.Literal("memory_limit"),
    }),
  }),
});

const InterfaceTools = Schema.Struct({
  id: Schema.Literal(2),
  result: Schema.Struct({
    tools: Schema.Tuple([
      Schema.Struct({ name: Schema.Literal("agent_code_execute") }),
    ]),
  }),
});

/** Servers may notify at any time, e.g. prompts/list_changed after startup.
 * Notifications carry a method and no id; the checks read only responses. */
const decodeServerNotification = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Never),
      method: Schema.String,
    })
  )
);
export const isServerNotification = (line: string): boolean =>
  Option.isSome(decodeServerNotification(line));

interface PackedMcpSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Starts one packed stdio server and initializes it. */
const openPackedMcp = Effect.fn("openPackedMcp")(function* open(
  spec: PackedMcpSpec,
  directory: string,
  env: Readonly<Record<string, string>>
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(spec.command, spec.args, {
      cwd: directory,
      env: {
        ...process.env,
        ...spec.env,
        CONTINGENCY_CATALOG_ROOT: path.join(directory, "catalog"),
        CONTINGENCY_MCP_PORT: "0",
        NODE_OPTIONS: "",
        ...env,
      },
      stderr: "inherit",
    })
  );
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string>();
  yield* Stream.fromQueue(input).pipe(
    Stream.run(child.stdin),
    Effect.forkScoped
  );
  yield* child.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== "" && !isServerNotification(line)),
    Stream.runForEach((line) => Queue.offer(output, line)),
    Effect.forkScoped
  );
  const send = (...messages: readonly object[]) =>
    Queue.offer(
      input,
      new TextEncoder().encode(
        `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
      )
    );
  const take = Queue.take(output);
  yield* send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      capabilities: {},
      clientInfo: { name: "release-install-check", version: "1.0.0" },
      protocolVersion: "2025-11-25",
    },
  });
  const response = yield* take;
  yield* Effect.try({
    catch: (cause) => new Error("Packed MCP initialize failed", { cause }),
    try: () =>
      Schema.decodeUnknownSync(InitializeResponse)(JSON.parse(response)),
  });
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { send, take };
});

const expectResponse = <S extends Schema.Decoder<unknown>>(
  schema: S,
  failure: string,
  response: string
) =>
  Effect.try({
    catch: (cause) => new Error(`${failure}: ${response}`, { cause }),
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(response)),
  });

export const verifyMcpHandshake = Effect.fn("verifyPackedMcpHandshake")(
  function* handshake(spec: PackedMcpSpec, directory: string) {
    // The native catalog serves the packed docs as resources (ADR 0063).
    const native = yield* openPackedMcp(spec, directory, {
      CONTINGENCY_MCP_INTERFACE: "native",
    });
    yield* native.send({
      id: 2,
      jsonrpc: "2.0",
      method: "resources/read",
      params: { uri: "contingency://docs/settings" },
    });
    yield* expectResponse(
      DocsResponse,
      "Packed Settings reference is not served",
      yield* native.take
    );

    // The default interface is the single tool (ADR 0059, #461). Leave the
    // variable unset so the packed default itself is checked.
    const single = yield* openPackedMcp(spec, directory, {});
    yield* single.send({
      id: 2,
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    yield* expectResponse(
      InterfaceTools,
      "Packed default catalog is not the single tool",
      yield* single.take
    );
    const interpret = (id: number, program: string) =>
      single.send({
        id,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: { code: program },
          name: "agent_code_execute",
        },
      });
    yield* interpret(
      3,
      'const listed = await tools.agent_sessions_get({ view: "compact" }); return listed.sessions.length'
    );
    yield* expectResponse(
      InterpreterResponse,
      "Packed interpreter execution failed",
      yield* single.take
    );
    yield* interpret(
      4,
      "const kept = []; for (let i = 0; i < 40; i++) { kept.push(new Array(1000000).fill(i)) } return kept.length"
    );
    yield* expectResponse(
      InterpreterCeilingResponse,
      "Packed interpreter ignored its heap ceiling",
      yield* single.take
    );
    yield* Console.log(
      "Packed MCP stdio initialize, docs resource, and single-tool interpreter passed."
    );
  },
  Effect.scoped,
  Effect.timeout("60 seconds")
);

/** Fail on peer overrides even when npm exits successfully. */
export const runInstallCheckCommand = Effect.fn("runInstallCheckCommand")(
  function* runCommand(
    command: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>> = {}
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* Effect.gen(function* collectCommand() {
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd,
          env: { ...process.env, ...env, NODE_OPTIONS: "" },
        })
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" }
      );
      if (
        exitCode !== 0 ||
        stdout.includes("ERESOLVE") ||
        stderr.includes("ERESOLVE")
      ) {
        return yield* Effect.fail(
          new Error(
            `${command} ${args.join(" ")} failed:\nStdout:\n${stdout}\nStderr:\n${stderr}`
          )
        );
      }
      return { stderr, stdout };
    }).pipe(Effect.scoped, Effect.timeout("60 seconds"));
  }
);

/** Pack once and pass this exact artifact to verification and publication. */
export const packCli = Effect.fn("packCli")(function* pack(
  root: string,
  output: string
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = path.join(root, "packages/cli");
  const packed = yield* runInstallCheckCommand(
    "npm",
    ["pack", "--ignore-scripts", "--json"],
    directory
  );
  const filename = yield* parseNpmPackOutput(packed);
  const tarball = path.join(directory, filename);
  yield* fs.writeFileString(output, `tarball=${tarball}\n`);
  yield* Console.log(`Packed CLI artifact: ${tarball}`);
});

/** Install the actual release artifact with no existing npm cache or lockfile. */
export const verifyCliInstall = Effect.fn("verifyCliInstall")(function* verify(
  root: string,
  tarball: string
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "contingency-install-",
  });
  yield* fs.writeFileString(
    path.join(directory, "package.json"),
    '{"private":true}\n'
  );
  // A fresh cache plus --offline proves no runtime dependency needs the registry.
  yield* runInstallCheckCommand(
    "npm",
    [
      "install",
      "--offline",
      "--strict-peer-deps",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(directory, "cache"),
      path.resolve(tarball),
    ],
    directory
  );
  yield* runInstallCheckCommand("npm", ["ls", "--all"], directory);
  const installed = path.join(
    directory,
    "node_modules/@contingencyhq/cli/dist/index.js"
  );
  const version = yield* runInstallCheckCommand(
    process.execPath,
    [installed, "--version"],
    directory
  );
  // Editors resolve `$schema` to this file on unpkg (ADR 0063).
  const schema = path.join(
    directory,
    "node_modules/@contingencyhq/cli/config.schema.json"
  );
  if (!(yield* fs.exists(schema))) {
    return yield* Effect.fail(
      new Error(`Packed CLI is missing ${path.basename(schema)}`)
    );
  }
  yield* verifyMcpHandshake(
    {
      args: [
        installed,
        "mcp",
        "--agent",
        "claude",
        "--fallback-directory",
        directory,
      ],
      command: process.execPath,
      env: {},
    },
    directory
  );
  const bin = path.join(directory, "bin");
  yield* fs.makeDirectory(bin);
  const agent = path.join(bin, "claude");
  yield* fs.writeFileString(
    agent,
    `#!${process.execPath}\nimport ${JSON.stringify(path.join(root, "packages/release/src/smoke-agent.ts"))};\n`
  );
  yield* fs.chmod(agent, 0o755);
  const startOutput = yield* runInstallCheckCommand(
    process.execPath,
    [installed, "start", "--agent", "claude"],
    directory,
    { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }
  );
  if (!startOutput.stdout.includes("Packed start launched MCP directly.")) {
    return yield* Effect.fail(
      new Error(
        `Packed start never launched the smoke agent:\n${startOutput.stdout}\n${startOutput.stderr}`
      )
    );
  }
  yield* Console.log("Packed start smoke passed.");
  yield* Console.log(
    `Clean packed CLI install passed: ${version.stdout.trim()}`
  );
}, Effect.scoped);
