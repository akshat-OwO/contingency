import path from "node:path";

import { AgentSessionId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";
import { mcpProgram } from "./scripted-agent.ts";

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
      const { executeOperation: call } = mcpProgram(request);
      yield* call("agent_catalog_select", {
        operationId: "select-origin",
        root,
      });
      const started = yield* call("agent_example_run_start", {
        example: "example-delivery-cart",
        inputs: [],
        operationId: "start-example-origin",
      });
      expect(started.status).toBe("completed");
      const session = Schema.decodeUnknownSync(Session)(started.value);
      const read = (documentPath: string, sessionId?: string) =>
        call("agent_flow_document_get", {
          flowName: "example-delivery-cart",
          path: documentPath,
          sessionId: sessionId ?? null,
        });
      const bundled = yield* fs.readFileString(
        path.resolve("examples/example-delivery-cart/targets.md")
      );
      expect(yield* read("targets.md", session.id)).toMatchObject({
        value: { content: bundled, path: "targets.md" },
      });
      expect((yield* read("targets.md")).status).toBe("program_failed");

      const local = path.join(root, "example-delivery-cart");
      yield* fs.makeDirectory(local, { recursive: true });
      yield* fs.writeFileString(path.join(local, "flow.md"), "# Local Flow");
      yield* fs.writeFileString(
        path.join(local, "targets.md"),
        "# Local targets"
      );
      expect(yield* read("targets.md", session.id)).toMatchObject({
        value: { content: bundled, path: "targets.md" },
      });
      expect(yield* read("targets.md")).toMatchObject({
        value: { content: "# Local targets", path: "targets.md" },
      });
      // Re-delivery on update must retain the Example origin as well.
      const updated = yield* call("agent_run_update", {
        inputs: [],
        operationId: "update-example-origin",
        referencedFlows: ["example-delivery-cart"],
        sessionId: session.id,
      });
      expect(updated.status).toBe("completed");
      expect(yield* read("targets.md", session.id)).toMatchObject({
        value: { content: bundled, path: "targets.md" },
      });
      for (const documentPath of [
        "../targets.md",
        "runs/private.md",
        "recordings/private.md",
        "nested/../targets.md",
        "flow.md",
      ]) {
        expect((yield* read(documentPath, session.id)).status).toBe(
          "program_failed"
        );
      }
      expect(
        (yield* call("agent_flow_document_get", {
          flowName: "unreferenced",
          path: "targets.md",
          sessionId: session.id,
        })).status
      ).toBe("program_failed");
      const invalid = yield* call("agent_flow_document_get", {
        flowName: "example-delivery-cart",
        origin: "example",
        path: "targets.md",
      });
      expect(invalid.status).toBe("program_failed");
      expect(invalid.receipts).toEqual([
        expect.objectContaining({
          message: expect.stringContaining("origin"),
          operation: "agent_flow_document_get",
          outcome: "failed",
        }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
