/* oxlint-disable eslint/no-await-in-loop -- MCP observations run in order. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "../../../..");
const require = createRequire(path.join(root, "packages/cli/package.json"));
const { Effect, Schema } = await import(
  pathToFileURL(require.resolve("effect")).href
);
const CommandFailure = Schema.Struct({
  code: Schema.Number,
  stderr: Schema.String,
  stdout: Schema.String,
});
const Tools = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        annotations: Schema.optional(
          Schema.Struct({
            destructiveHint: Schema.optional(Schema.Boolean),
            readOnlyHint: Schema.optional(Schema.Boolean),
          })
        ),
        description: Schema.String,
        inputSchema: Schema.Unknown,
        name: Schema.String,
        outputSchema: Schema.optional(Schema.Unknown),
      })
    ),
  })
);
const MissingSession = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.Literal("ios_session_not_found"),
    message: Schema.String,
  })
);
const Sessions = Schema.fromJsonString(Schema.Array(Schema.Json));
const Input = Schema.Struct({
  properties: Schema.Struct({
    platform: Schema.Struct({ enum: Schema.Array(Schema.String) }),
  }),
  required: Schema.Array(Schema.String),
});
const artifacts = path.join(
  root,
  ".cursor/skills/verify-contingency/artifacts/device-mcp"
);
const execute = promisify(execFile);
const journal = [];
assert.ok(
  process.env.CONTINGENCY_VERIFY_DIR,
  "Set CONTINGENCY_VERIFY_DIR to the owned instance."
);
await mkdir(artifacts, { recursive: true });
const control = async (...args) => {
  const result = await Effect.runPromise(
    Effect.tryPromise({
      catch: (cause) => cause,
      try: () =>
        execute(
          "nub",
          [path.join(import.meta.dirname, "control-contingency"), ...args],
          {
            cwd: root,
            env: process.env,
            maxBuffer: 8 * 1024 * 1024,
          }
        ).then(
          ({ stdout, stderr }) => ({ code: 0, stderr, stdout }),
          (error) => Schema.decodeUnknownSync(CommandFailure)(error)
        ),
    })
  );
  journal.push({ args, ...result });
  return result;
};
const call = (name, params) =>
  control("mcp", "call", "--tool", name, "--params", JSON.stringify(params));
try {
  const listed = await control("mcp", "tools");
  assert.equal(listed.code, 0);
  const { tools } = Schema.decodeUnknownSync(Tools)(listed.stdout);
  const device = tools.filter(({ name }) => name.startsWith("agent_device_"));
  assert.deepEqual(device.map(({ name }) => name).toSorted(), [
    "agent_device_sessions_list",
    "agent_device_workspace",
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) <= 102_000);
  assert.ok(Buffer.byteLength(JSON.stringify(device)) <= 10_000);
  for (const tool of device) {
    const input = Schema.decodeUnknownSync(Input)(tool.inputSchema);
    assert.ok(input.required.includes("platform"));
    assert.deepEqual(input.properties.platform.enum, ["android", "ios"]);
  }
  const iosListed = await call("agent_device_sessions_list", {
    platform: "ios",
  });
  assert.equal(iosListed.code, 0);
  Schema.decodeUnknownSync(Sessions)(iosListed.stdout);
  const missing = await call("agent_device_workspace", {
    command: { _tag: "read", sessionId: "agent-ios-absent" },
    platform: "ios",
  });
  assert.equal(missing.code, 2);
  Schema.decodeUnknownSync(MissingSession)(missing.stdout);

  const sessions = await call("agent_device_sessions_list", {
    platform: "android",
  });
  assert.equal(sessions.code, 0);
  const retained = Schema.decodeUnknownSync(Sessions)(sessions.stdout);
  const reread = await call("agent_device_sessions_list", {
    platform: "android",
  });
  assert.equal(reread.code, 0);
  assert.deepEqual(Schema.decodeUnknownSync(Sessions)(reread.stdout), retained);
  const receipt = {
    catalogBytes: Buffer.byteLength(JSON.stringify(tools)),
    deviceBytes: Buffer.byteLength(JSON.stringify(device)),
    feature: "device-mcp-contract",
    status: "passed",
  };
  await writeFile(
    path.join(artifacts, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await writeFile(
    path.join(artifacts, "journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`
  );
}
