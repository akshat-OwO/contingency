import path from "node:path";

import { AgentSessionId } from "@contingency/protocol";
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
      receipts: Schema.Array(
        Schema.Struct({
          message: Schema.optional(Schema.String),
          operation: Schema.String,
          outcome: Schema.String,
        })
      ),
      status: Schema.String,
      value: Schema.optional(Schema.Unknown),
    }),
  }),
});
const Session = Schema.Struct({ id: AgentSessionId });

it.live(
  "fetches Example documents from their Run origin in empty and colliding catalogs",
  () =>
    Effect.gen(function* fetchExampleDocuments() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const { request } = yield* connectMcp(
        yield* servingMcpHttp({ demo: true })
      );
      const call = (name: string, args: Parameters<typeof request>[1]) =>
        request("tools/call", operationParams(name, args)).pipe(
          Effect.map((answer) => {
            expect(answer, name).toHaveProperty("result");
            return Schema.decodeUnknownSync(Answer)(answer);
          })
        );
      yield* call("agent_catalog_select", {
        operationId: "select-origin",
        root,
      });
      const started = yield* call("agent_example_run_start", {
        example: "example-delivery-cart",
        inputs: [],
        operationId: "start-example-origin",
      });
      expect(started.result.isError).not.toBe(true);
      const session = Schema.decodeUnknownSync(Session)(
        started.result.structuredContent.value
      );
      const read = (documentPath: string, sessionId?: string) =>
        call("agent_flow_document_get", {
          flowName: "example-delivery-cart",
          path: documentPath,
          sessionId: sessionId ?? null,
        });
      const bundled = yield* fs.readFileString(
        path.resolve("examples/example-delivery-cart/targets.md")
      );
      expect((yield* read("targets.md", session.id)).result).toMatchObject({
        structuredContent: { value: { content: bundled, path: "targets.md" } },
      });
      expect((yield* read("targets.md")).result.structuredContent.status).toBe(
        "program_failed"
      );

      const local = path.join(root, "example-delivery-cart");
      yield* fs.makeDirectory(local, { recursive: true });
      yield* fs.writeFileString(path.join(local, "flow.md"), "# Local Flow");
      yield* fs.writeFileString(
        path.join(local, "targets.md"),
        "# Local targets"
      );
      expect((yield* read("targets.md", session.id)).result).toMatchObject({
        structuredContent: { value: { content: bundled, path: "targets.md" } },
      });
      expect((yield* read("targets.md")).result).toMatchObject({
        structuredContent: {
          value: { content: "# Local targets", path: "targets.md" },
        },
      });
      // Re-delivery on update must retain the Example origin as well.
      const updated = yield* call("agent_run_update", {
        inputs: [],
        operationId: "update-example-origin",
        referencedFlows: ["example-delivery-cart"],
        sessionId: session.id,
      });
      expect(updated.result.isError).not.toBe(true);
      expect((yield* read("targets.md", session.id)).result).toMatchObject({
        structuredContent: { value: { content: bundled, path: "targets.md" } },
      });
      for (const documentPath of [
        "../targets.md",
        "runs/private.md",
        "recordings/private.md",
        "nested/../targets.md",
        "flow.md",
      ]) {
        expect(
          (yield* read(documentPath, session.id)).result.structuredContent
            .status
        ).toBe("program_failed");
      }
      expect(
        (yield* call("agent_flow_document_get", {
          flowName: "unreferenced",
          path: "targets.md",
          sessionId: session.id,
        })).result.structuredContent.status
      ).toBe("program_failed");
      const invalid = yield* call("agent_flow_document_get", {
        flowName: "example-delivery-cart",
        origin: "example",
        path: "targets.md",
      });
      expect(invalid.result.structuredContent.status).toBe("program_failed");
      expect(invalid.result.structuredContent.receipts).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("origin"),
          operation: "agent_flow_document_get",
          outcome: "failed",
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
