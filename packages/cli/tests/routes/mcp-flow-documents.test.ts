import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import {
  connectMcp,
  operationParams,
  servingMcpHttp,
} from "../helpers/mcp-http.ts";

const Answer = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
      receipts: Schema.Array(
        Schema.Struct({
          operation: Schema.String,
          outcome: Schema.String,
          message: Schema.optional(Schema.String),
        })
      ),
    }),
  }),
});

it.live(
  "fetches supporting documents through MCP and refuses evidence and escapes",
  () =>
    Effect.gen(function* fetchDocument() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const flow = path.join(root, "checkout");
      for (const file of [
        "flow.md",
        "knowledge/deep/rules.md",
        "runs/private.md",
        "recordings/private.md",
        "image.txt",
      ]) {
        yield* fs.makeDirectory(path.dirname(path.join(flow, file)), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(flow, file),
          "# Rules\nUse the receipt."
        );
      }
      const { request } = yield* connectMcp(yield* servingMcpHttp());
      yield* request(
        "tools/call",
        operationParams("agent_catalog_select", {
          root,
          operationId: "select-documents",
        })
      );
      const read = (documentPath: string) =>
        request(
          "tools/call",
          operationParams("agent_flow_document_get", {
            flowName: "checkout",
            path: documentPath,
          })
        ).pipe(Effect.map(Schema.decodeUnknownSync(Answer)));
      expect((yield* read("knowledge/deep/rules.md")).result).toMatchObject({
        structuredContent: {
          value: {
            path: "knowledge/deep/rules.md",
            content: "# Rules\nUse the receipt.",
          },
        },
      });
      for (const documentPath of [
        "../outside.md",
        "runs/private.md",
        "recordings/private.md",
        "image.txt",
      ]) {
        const refused = (yield* read(documentPath)).result.structuredContent;
        expect(refused.status).toBe("program_failed");
        expect(refused.receipts).toEqual([
          expect.objectContaining({
            operation: "agent_flow_document_get",
            outcome: "failed",
          }),
        ]);
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer)
    )
);
