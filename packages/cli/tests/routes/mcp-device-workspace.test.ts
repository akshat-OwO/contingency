import { OperationId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { IosWorkspace } from "../../src/services/ios-workspace.ts";
import { DeviceWorkspaceTools } from "../../src/services/mcp-device-workspace.ts";
import { OwnedDevices } from "../../src/services/owned-devices.ts";
import {
  connectMcp,
  operationParams,
  servingMcpHttp,
} from "../helpers/mcp-http.ts";

const Answer = Schema.Struct({
  result: Schema.Struct({
    content: Schema.Array(Schema.Struct({ text: Schema.String })),
    isError: Schema.Boolean,
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
      diagnostic: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
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
      yield* request(
        "tools/call",
        operationParams("agent_device_sessions_list", { platform: "ios" })
      )
    ).result;
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent.value).toEqual([]);
    const read = Schema.decodeUnknownSync(Answer)(
      yield* request(
        "tools/call",
        operationParams("agent_device_workspace", {
          platform: "ios",
          command: { _tag: "read", sessionId: "agent-ios-absent" },
        })
      )
    ).result;
    expect(read.isError).toBe(false);
    expect(read.structuredContent.status).toBe("program_failed");
    expect(read.structuredContent.diagnostic?.message).toContain(
      "Unknown iOS session."
    );
  }).pipe(
    Effect.provideService(IosWorkspace, {
      activeRunFlowNames: () => Effect.succeed([]),
      execute: () =>
        Effect.fail({
          code: "ios_workspace_refused",
          message: "Unknown iOS session.",
        }),
      forward: () => Effect.void,
      keyframes: () => Effect.succeed(null),
      list: () => Effect.succeed([]),
      stream: () => Effect.succeed(null),
      video: () => Effect.succeed(null),
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

const erased: string[] = [];
const asked: string[] = [];
it.live("an agent's Device Erase request only asks, and never erases", () =>
  Effect.gen(function* eraseRequest() {
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    const call = (platform: "android" | "ios", device: string) =>
      request(
        "tools/call",
        operationParams("agent_device_workspace", {
          command: {
            _tag: "device-erase-request",
            device,
            operationId: `erase-${device}`,
          },
          platform,
        })
      ).pipe(
        Effect.map((answer) => Schema.decodeUnknownSync(Answer)(answer).result)
      );
    const asking = yield* call("android", "Pixel_9");
    expect(asking.structuredContent.status).not.toBe("program_failed");
    expect(asking.structuredContent.value).toMatchObject({
      device: "Pixel_9",
      platform: "android",
      status: "pending",
    });
    const refused = yield* call("ios", "not-a-udid");
    expect(refused.structuredContent.diagnostic?.message).toContain("UDID");
    expect(asked).toEqual(["android:Pixel_9"]);
    expect(erased).toEqual([]);
  }).pipe(
    Effect.provideService(OwnedDevices, {
      bootAndroid: () => Effect.die("Booting is not requested."),
      bootIos: () => Effect.die("Booting is not requested."),
      dismissErase: () => Effect.void,
      erase: ({ device }) =>
        Effect.sync(() => {
          erased.push(device);
        }),
      eraseState: Effect.succeed({
        owned: { android: [], ios: [] },
        requests: [],
      }),
      requestErase: ({ device, operationId, platform }) =>
        Effect.sync(() => {
          asked.push(`${platform}:${device}`);
          return {
            device,
            id: OperationId.make(operationId),
            platform,
            requestedAt: "2026-11-14T00:00:00.000Z",
            status: "pending" as const,
          };
        }),
    }),
    Effect.scoped,
    Effect.provide(NodeServices.layer)
  )
);
