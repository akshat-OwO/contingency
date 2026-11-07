import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const Answer = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.Struct({
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
      receipts: Schema.optional(
        Schema.Array(
          Schema.Struct({
            operation: Schema.String,
            outcome: Schema.String,
            message: Schema.optional(Schema.String),
          })
        )
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
      const refusedPaths = [
        "../outside.md",
        "runs/private.md",
        "recordings/private.md",
        "image.txt",
      ];
      // One program exercises the sequential operations without starting a
      // fresh interpreter for every document in this filesystem contract.
      const response = Schema.decodeUnknownSync(Answer)(
        yield* request("tools/call", {
          arguments: {
            code: `
              await tools.agent_catalog_select({ root: ${JSON.stringify(root)}, operationId: "select-documents" });
              const document = await tools.agent_flow_document_get({ flowName: "checkout", path: "knowledge/deep/rules.md" });
              const refused = [];
              for (const path of ${JSON.stringify(refusedPaths)}) {
                try {
                  await tools.agent_flow_document_get({ flowName: "checkout", path });
                  refused.push({ path, accepted: true });
                } catch (error) {
                  refused.push({ path, accepted: false });
                }
              }
              return { document, refused };
            `,
          },
          name: "agent_code_execute",
        })
      ).result;
      expect(response.isError).toBe(false);
      expect(response.structuredContent.status).toBe("completed");
      expect(response.structuredContent.value).toMatchObject({
        document: {
          path: "knowledge/deep/rules.md",
          content: "# Rules\nUse the receipt.",
        },
        refused: refusedPaths.map((documentPath) => ({
          accepted: false,
          path: documentPath,
        })),
      });
      expect(response.structuredContent.receipts).toEqual(
        refusedPaths.map(() =>
          expect.objectContaining({
            operation: "agent_flow_document_get",
            outcome: "failed",
          })
        )
      );
    }).pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.provide(NodeServices.layer)
    )
);
