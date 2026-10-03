import {
  AgentBrowserStorageDelete,
  AgentBrowserStorageSet,
  AgentSessionStartRequest,
  AgentTeachingFlowVerified,
  ContingencyRpcs,
} from "@contingency/protocol";
import { Schema } from "effect";
import { RpcSchema } from "effect/rpc";
import { expect, test } from "vitest";

test("RPC payloads and unary results expose data without tag envelopes", () => {
  for (const rpc of ContingencyRpcs.requests.values()) {
    for (const schema of [rpc.payloadSchema, rpc.successSchema]) {
      if (RpcSchema.isStreamSchema(schema)) {
        continue;
      }
      const document = Schema.toJsonSchemaDocument(schema);
      const serialized = JSON.stringify(document);
      expect(serialized).not.toContain('"data":');
      expect(serialized).not.toContain(`"const":"${rpc._tag}"`);
    }
  }
});

test("plain session requests and Teaching results survive protocol round trips", () => {
  const request = {
    activity: "teaching",
    clientName: "Workspace",
    clientVersion: "1.0.0",
    name: "browse-catalogue",
    operationId: "start-one",
    url: "https://example.com/",
    viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
  };
  const result = {
    captureState: { _tag: "setup", requestedAt: "2026-10-03T00:00:00.000Z" },
    cleanup: { _tag: "pending" },
  };
  for (const [schema, value] of [
    [AgentSessionStartRequest, request],
    [AgentTeachingFlowVerified, result],
  ] as const) {
    const encoded = Schema.encodeUnknownSync(schema)(value);
    expect(encoded).toEqual(value);
    expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value);
  }
});

test("storage payload unions retain their kind discriminator without an RPC envelope", () => {
  for (const [schema, value] of [
    [
      AgentBrowserStorageSet,
      {
        key: "cart",
        kind: "local",
        sessionId: "agent-one",
        tabId: "tab-one",
        value: "one",
      },
    ],
    [
      AgentBrowserStorageSet,
      {
        cookie: {
          domain: "example.com",
          httpOnly: false,
          name: "cart",
          path: "/",
          secure: true,
          value: "one",
        },
        kind: "cookies",
        sessionId: "agent-one",
        tabId: "tab-one",
      },
    ],
    [
      AgentBrowserStorageDelete,
      {
        key: "cart",
        kind: "session",
        sessionId: "agent-one",
        tabId: "tab-one",
      },
    ],
    [
      AgentBrowserStorageDelete,
      {
        domain: "example.com",
        kind: "cookies",
        name: "cart",
        path: "/",
        sessionId: "agent-one",
        tabId: "tab-one",
      },
    ],
  ] as const) {
    expect(
      Schema.encodeUnknownSync(schema)(Schema.decodeUnknownSync(schema)(value))
    ).toEqual(value);
  }
});
