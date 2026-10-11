import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Schema } from "effect";

import { verifyMcpHandshake } from "./verify-cli-install.ts";

const Configuration = Schema.Struct({
  mcpServers: Schema.Struct({
    contingency: Schema.Struct({
      args: Schema.Array(Schema.String),
      command: Schema.String,
      env: Schema.Record(Schema.String, Schema.String),
    }),
  }),
});

/** A disposable Claude stand-in, with no authentication or model request. */
const smoke = Effect.gen(function* runSmokeAgent() {
  if (process.argv.includes("--version")) {
    yield* Console.log("2.1.289 (Claude Code)");
    return;
  }
  const config = process.argv[process.argv.indexOf("--mcp-config") + 1];
  const { mcpServers } = yield* Effect.try({
    catch: (cause) =>
      new Error("Invalid packed start MCP configuration", { cause }),
    try: () =>
      Schema.decodeUnknownSync(Configuration)(JSON.parse(config ?? "")),
  });
  const spec = mcpServers.contingency;
  if (
    spec.command !== process.execPath ||
    !path.isAbsolute(spec.args[0] ?? "")
  ) {
    return yield* Effect.fail(
      new Error("start must launch the installed CLI directly")
    );
  }
  yield* verifyMcpHandshake(spec, process.cwd());
  yield* Console.log("Packed start launched MCP directly.");
});

smoke.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
