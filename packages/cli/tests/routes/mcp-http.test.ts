import { createServer, request } from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { makeAgentRunStoreLayer } from "../../src/services/agent-run-store.ts";
import { makeAgentSessionLayer } from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { makeDemoSiteLayer } from "../../src/services/demo-site-server.ts";
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import {
  MCP_HTTP_PATH,
  makeMcpHttpLayer,
} from "../../src/services/mcp-http.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const initializeBody = JSON.stringify({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "verify", version: "1.0" },
    protocolVersion: "2025-06-18",
  },
});

const serving = Effect.fn("servingMcpHttp")(function* servingMcpHttp(
  skillContent?: string
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const catalogRoot = yield* fileSystem.makeTempDirectoryScoped();
  if (skillContent !== undefined) {
    yield* fileSystem.makeDirectory(`${catalogRoot}/input-forms`);
    yield* fileSystem.writeFileString(
      `${catalogRoot}/input-forms/SKILL.md`,
      skillContent
    );
  }
  const allowedOrigins = new Set(["http://127.0.0.1:7783"]);
  const context = yield* Layer.build(
    HttpRouter.serve(makeMcpHttpLayer(allowedOrigins)).pipe(
      Layer.provide(
        Layer.mergeAll(
          makeAgentSessionLayer({
            allowedActivity: "any",
            baseUrl: "http://127.0.0.1:7783",
          }),
          makeFlowSkillCatalogLayer({ root: catalogRoot }),
          makeAgentRunStoreLayer({ root: () => catalogRoot }),
          makeTeachingRecordingStoreLayer({ root: () => catalogRoot }),
          makeDemoSiteLayer()
        ).pipe(
          Layer.provideMerge(CreateBrowserLive),
          Layer.provideMerge(NodeServices.layer)
        )
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );
  const server = Context.get(context, HttpServer.HttpServer);
  const { address } = server;
  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die("Expected a TCP server.");
  }
  return `http://127.0.0.1:${address.port}`;
});

const postMcp = (
  origin: string,
  headers: Record<string, string>,
  body: string = initializeBody
) =>
  Effect.promise(() =>
    fetch(`${origin}${MCP_HTTP_PATH}`, {
      body,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      method: "POST",
    })
  );

it.live("lists every input declaration form as JSON-safe MCP content", () =>
  Effect.gen(function* listsInputForms() {
    const origin = yield* serving(`---
name: input-forms
description: Exercise input declarations.
inputs:
  - bare
  - name: mapped
  - name: described
    description: The documented value.
---

1. Fill the input fields.
   Done when: Each field contains its requested value.
`);
    const initialized = yield* postMcp(origin, {
      "mcp-protocol-version": "2025-06-18",
    });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).not.toBeNull();
    const response = yield* postMcp(
      origin,
      {
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": sessionId ?? "",
      },
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "agent_flow_skills_list" },
      })
    );
    expect(response.status).toBe(200);
    const payload: unknown = yield* Effect.promise(() => response.json());
    const listing = {
      flowSkills: [
        {
          description: "Exercise input declarations.",
          inputs: [
            { name: "bare" },
            { name: "mapped" },
            { description: "The documented value.", name: "described" },
          ],
          name: "input-forms",
          stepCount: 1,
        },
      ],
    };
    expect(payload).toEqual({
      id: 2,
      jsonrpc: "2.0",
      result: {
        content: [{ text: JSON.stringify(listing), type: "text" }],
        isError: false,
        structuredContent: listing,
      },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "serves Streamable HTTP MCP on a stable path so URL clients share one process",
  () =>
    Effect.gen(function* answersInitializeOverHttp() {
      const origin = yield* serving();
      const initialized = yield* postMcp(origin, {
        "mcp-protocol-version": "2025-06-18",
      });
      expect(initialized.status).toBe(200);
      const payload: unknown = yield* Effect.promise(() => initialized.json());
      expect(payload).toEqual(
        expect.objectContaining({
          id: 1,
          jsonrpc: "2.0",
          result: expect.objectContaining({
            protocolVersion: "2025-06-18",
            serverInfo: { name: "Contingency", version: "0.0.1" },
          }),
        })
      );

      const get = yield* Effect.promise(() =>
        fetch(`${origin}${MCP_HTTP_PATH}`)
      );
      expect(get.status).toBe(405);

      const crossOrigin = yield* postMcp(origin, {
        origin: "https://evil.example",
      });
      expect(crossOrigin.status).toBe(403);

      const rebound = yield* Effect.callback<number>((resume) => {
        const call = request(
          `${origin}${MCP_HTTP_PATH}`,
          {
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              host: "rebind.evil:7783",
            },
            method: "POST",
          },
          (response) => {
            response.resume();
            resume(Effect.succeed(response.statusCode ?? 0));
          }
        );
        call.on("error", (cause) => resume(Effect.die(cause)));
        call.end(initializeBody);
      });
      expect(rebound).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "publishes usable Agent Assessment evidence and explains bad items",
  () =>
    Effect.gen(function* assessmentEvidenceContract() {
      const origin = yield* serving();
      const initialized = yield* postMcp(origin, {
        "mcp-protocol-version": "2025-06-18",
      });
      expect(initialized.status).toBe(200);
      const sessionId = initialized.headers.get("mcp-session-id");
      expect(sessionId).not.toBeNull();
      const headers = {
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": sessionId ?? "",
      };
      const listed = yield* postMcp(
        origin,
        headers,
        JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        })
      );
      expect(listed.status).toBe(200);
      const listedJson: unknown = yield* Effect.promise(() => listed.json());
      const decoded = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            tools: Schema.Array(
              Schema.Struct({
                description: Schema.optional(Schema.String),
                inputSchema: Schema.Unknown,
                name: Schema.String,
              })
            ),
          }),
        })
      )(listedJson);
      expect(
        decoded.result.tools.some(
          (tool) => tool.name === "agent_run_step_assess"
        )
      ).toBe(false);
      const assessment = decoded.result.tools.find(
        (tool) => tool.name === "agent_run_assess"
      );
      expect(assessment?.description).toContain(
        '{"kind":"attempt","id":"action-123"}'
      );
      expect(assessment?.description).toContain(
        '{"kind":"snapshot","id":"snapshot-2"}'
      );
      expect(JSON.stringify(assessment?.inputSchema)).not.toContain('"allOf"');
      expect(assessment?.inputSchema).toEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            evidence: expect.objectContaining({
              minItems: 1,
              type: "array",
              items: expect.objectContaining({
                type: "object",
                required: ["id", "kind"],
                properties: expect.objectContaining({
                  id: expect.objectContaining({ type: "string" }),
                  kind: {
                    type: "string",
                    enum: ["snapshot", "attempt", "artifact"],
                  },
                }),
              }),
            }),
          }),
        })
      );

      for (const name of ["agent_run_assess", "agent_run_finding"]) {
        const taskTool = decoded.result.tools.find(
          (tool) => tool.name === name
        );
        const schema = JSON.stringify(taskTool?.inputSchema);
        expect(schema).toContain('"enum":["snapshot","attempt","artifact"]');
        expect(schema).not.toContain('"screenshot"');
        expect(schema).toContain('"artifact"');
      }

      const invalid = yield* postMcp(
        origin,
        headers,
        JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              evidence: ["snapshot-2"],
              explanation: "The page loaded.",
              operationId: "invalid-evidence",
              outcome: "working",
              sessionId: "agent-example",
            },
            name: "agent_run_assess",
          },
        })
      );
      expect(invalid.status).toBe(200);
      const invalidJson: unknown = yield* Effect.promise(() => invalid.json());
      expect(invalidJson).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: -32_602,
            message: expect.stringContaining(
              'Evidence item needs {kind,id}: kind must be "snapshot", "attempt", or "artifact"'
            ),
          }),
        })
      );
      expect(JSON.stringify(invalidJson)).toContain('[\\"evidence\\"][0]');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
