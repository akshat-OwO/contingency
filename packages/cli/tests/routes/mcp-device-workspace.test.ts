import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { DeviceWorkspaceTools } from "../../src/services/mcp-device-workspace.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const Answer = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.Boolean,
  }),
});
const Unavailable = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.Literal("ios_support_matrix_unproven"),
    message: Schema.String,
  })
);

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

it.live("refuses iOS with a typed tool failure before accessing Android", () =>
  Effect.gen(function* iosUnavailable() {
    // No AndroidWorkspace service is installed: iOS must never access it.
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    for (const name of [
      "agent_device_workspace",
      "agent_device_sessions_list",
    ]) {
      const answer = Schema.decodeUnknownSync(Answer)(
        yield* request("tools/call", {
          arguments:
            name === "agent_device_workspace"
              ? {
                  command: { _tag: "read", sessionId: "agent-ios-unavailable" },
                  platform: "ios",
                }
              : { platform: "ios" },
          name,
        })
      ).result;
      expect(answer.isError).toBe(true);
      const refusal = Schema.decodeUnknownSync(Unavailable)(
        answer.content[0]?.text
      );
      expect(refusal.message).toBe(
        "iOS is unavailable until its Support Matrix is proven."
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
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
