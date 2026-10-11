import path from "node:path";

import { Console, Effect, FileSystem, Queue, Schema, Stream } from "effect";
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
const CodeResponse = Schema.Struct({
  id: Schema.Literal(2),
  result: Schema.Struct({
    isError: Schema.Literal(false),
    structuredContent: Schema.Struct({
      calls: Schema.Literal(0),
      result: Schema.Literal(42),
    }),
  }),
});

export const verifyMcpHandshake = Effect.fn("verifyPackedMcpHandshake")(
  function* handshake(
    spec: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    },
    directory: string
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(spec.command, spec.args, {
        cwd: directory,
        env: {
          ...process.env,
          ...spec.env,
          CONTINGENCY_CATALOG_ROOT: path.join(directory, "catalog"),
          CONTINGENCY_MCP_CODE_MODE: "true",
          CONTINGENCY_MCP_PORT: "0",
          NODE_OPTIONS: "",
        },
        stderr: "inherit",
      })
    );
    const request = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "release-install-check", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    });
    const input = yield* Queue.unbounded<Uint8Array>();
    const output = yield* Queue.unbounded<string>();
    yield* Stream.fromQueue(input).pipe(
      Stream.run(child.stdin),
      Effect.forkScoped
    );
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.trim() !== ""),
      Stream.runForEach((line) => Queue.offer(output, line)),
      Effect.forkScoped
    );
    yield* Queue.offer(input, new TextEncoder().encode(`${request}\n`));
    const response = yield* Queue.take(output);
    yield* Effect.try({
      catch: (cause) => new Error("Packed MCP initialize failed", { cause }),
      try: () =>
        Schema.decodeUnknownSync(InitializeResponse)(JSON.parse(response)),
    });
    const code = [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { code: "return 42;" }, name: "agent_code_run" },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    yield* Queue.offer(input, new TextEncoder().encode(`${code}\n`));
    const result = yield* Queue.take(output);
    yield* Effect.try({
      catch: (cause) =>
        new Error(`Packed QuickJS execution failed: ${result}`, { cause }),
      try: () => Schema.decodeUnknownSync(CodeResponse)(JSON.parse(result)),
    });
    yield* Console.log(
      "Packed MCP stdio initialize and QuickJS execution passed."
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
