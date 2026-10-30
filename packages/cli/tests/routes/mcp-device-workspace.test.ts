import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { DeviceWorkspaceTools } from "../../src/services/mcp-device-workspace.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const Answer = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.Boolean,
  }),
});
it("requires an explicit device platform on both tools", () => {
  for (const tool of Object.values(DeviceWorkspaceTools.tools)) {
    const command = { _tag: "read", sessionId: "agent-device-1" };
    const params = tool.name === "agent_device_workspace" ? { command } : {};
    const accepts = Schema.is(tool.parametersSchema);
    expect(accepts(params)).toBe(false);
    expect(accepts({ ...params, platform: "browser" })).toBe(false);
    expect(accepts({ ...params, platform: "android" })).toBe(true);
    expect(accepts({ ...params, platform: "ios" })).toBe(true);
  }
});

it.live("routes public iOS calls to iOS without accessing Android", () =>
  Effect.gen(function* iosPublic() {
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    const listed = Schema.decodeUnknownSync(Answer)(
      yield* request("tools/call", {
        name: "agent_device_sessions_list",
        arguments: { platform: "ios" },
      })
    ).result;
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.content[0]?.text ?? "null")).toEqual([]);
    const read = Schema.decodeUnknownSync(Answer)(
      yield* request("tools/call", {
        name: "agent_device_workspace",
        arguments: {
          platform: "ios",
          command: { _tag: "read", sessionId: "agent-ios-absent" },
        },
      })
    ).result;
    expect(read.isError).toBe(true);
    expect(JSON.parse(read.content[0]?.text ?? "null")).toEqual({
      code: "ios_workspace_refused",
      message: "Unknown iOS session.",
    });
  }).pipe(
    Effect.provideService(IosWorkspace, {
      execute: () =>
        Effect.fail({
          code: "ios_workspace_refused",
          message: "Unknown iOS session.",
        }),
      list: () => Effect.succeed([]),
      stream: () => Effect.succeed(null),
    }),
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  )
);

it("exposes Return to Target App in the device workspace command schema", () => {
  const accepts = Schema.is(
    DeviceWorkspaceTools.tools.agent_device_workspace.parametersSchema
  );
  expect(
    accepts({
      command: {
        _tag: "return-to-target-app",
        operationId: "return-1",
        sessionId: "agent-ios-session",
      },
      platform: "ios",
    })
  ).toBe(true);
});

it("keeps user-only preparation and verification out of MCP", () => {
  const accepts = Schema.is(
    DeviceWorkspaceTools.tools.agent_device_workspace.parametersSchema
  );
  for (const platform of ["android", "ios"]) {
    expect(
      accepts({
        platform,
        command: {
          _tag: "prepare",
          operationId: "one",
          sessionId: "agent-device-1",
        },
      })
    ).toBe(false);
    expect(
      accepts({
        platform,
        command: {
          _tag: "flow-decision",
          operationId: "one",
          sessionId: "agent-device-1",
          decision: "verify",
        },
      })
    ).toBe(false);
  }
});
