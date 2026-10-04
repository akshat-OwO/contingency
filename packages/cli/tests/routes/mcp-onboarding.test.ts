import { request as httpRequest } from "node:http";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { LEARN_FLOW_SKILL_URI } from "../../src/services/mcp-authoring-skills.ts";
import {
  EXAMPLES_URI,
  STARTER_PROMPT_URI,
} from "../../src/services/mcp-onboarding.ts";
import { ONBOARDING_EXAMPLES } from "../../src/services/onboarding-examples.ts";
import { connectMcp, servingMcpHttp } from "../helpers/mcp-http.ts";

const ResourceList = Schema.Struct({
  result: Schema.Struct({
    resources: Schema.Array(Schema.Struct({ uri: Schema.String })),
  }),
});

const ResourceRead = Schema.Struct({
  result: Schema.Struct({
    contents: Schema.Array(Schema.Struct({ text: Schema.String })),
  }),
});

const read = (
  request: Effect.Success<ReturnType<typeof connectMcp>>["request"],
  uri: string
) =>
  request("resources/read", { uri }).pipe(
    Effect.map(
      (response) =>
        Schema.decodeUnknownSync(ResourceRead)(response).result.contents[0]
          ?.text ?? ""
    )
  );

/** A GET with an explicit Host header, as a browser resolving the name sends it. */
const getWithHost = (port: number, host: string, path: string) =>
  Effect.callback<{ readonly body: string; readonly status: number }>(
    (resume) => {
      const outgoing = httpRequest(
        { headers: { host }, host: "127.0.0.1", method: "GET", path, port },
        (response) => {
          let body = "";
          response.setEncoding("utf-8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resume(Effect.succeed({ body, status: response.statusCode ?? 0 }));
          });
        }
      );
      outgoing.on("error", (cause) => {
        resume(Effect.die(cause));
      });
      outgoing.end();
    }
  );

it.live(
  "serves the starter prompt, the learning procedure, and this process's examples",
  () =>
    Effect.gen(function* onboardingResources() {
      const { request } = yield* connectMcp(yield* servingMcpHttp());
      const listed = Schema.decodeUnknownSync(ResourceList)(
        yield* request("resources/list", {})
      );
      const uris = listed.result.resources.map((resource) => resource.uri);
      expect(uris).toEqual(
        expect.arrayContaining([
          STARTER_PROMPT_URI,
          EXAMPLES_URI,
          LEARN_FLOW_SKILL_URI,
        ])
      );

      const starter = yield* read(request, STARTER_PROMPT_URI);
      expect(starter).toContain("agent_catalog_get");
      expect(starter).toContain("agent_example_run_start");
      expect(starter).toContain(LEARN_FLOW_SKILL_URI);
      // One authoritative learning procedure: the starter prompt points to it.
      expect(starter).not.toContain("agent_teaching_recording_claim");

      const learn = yield* read(request, LEARN_FLOW_SKILL_URI);
      expect(learn).toContain("agent_flow_skill_save");
      expect(learn).toContain('decision "verify"');

      const examples = yield* read(request, EXAMPLES_URI);
      for (const example of ONBOARDING_EXAMPLES) {
        expect(examples).toContain(example.flowSkillName);
      }
      const origin = /http:\/\/ridgeline\.localhost:(?<port>\d+)\//u.exec(
        examples
      );
      expect(origin).not.toBeNull();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("serves the demo store only under its hostname and port", () =>
  Effect.gen(function* demoHostGuard() {
    const { request } = yield* connectMcp(yield* servingMcpHttp());
    const examples = yield* read(request, EXAMPLES_URI);
    const port = Number(
      /http:\/\/ridgeline\.localhost:(?<port>\d+)\//u.exec(examples)?.groups
        ?.port
    );
    const home = yield* getWithHost(port, `ridgeline.localhost:${port}`, "/");
    expect(home.status).toBe(200);
    expect(home.body).toContain(
      "Ridgeline Hardware is a Contingency demo store"
    );
    const script = yield* getWithHost(
      port,
      `ridgeline.localhost:${port}`,
      "/app.js"
    );
    expect(script.status).toBe(200);
    expect((yield* getWithHost(port, `127.0.0.1:${port}`, "/")).status).toBe(
      421
    );
    expect((yield* getWithHost(port, `evil.test:${port}`, "/")).status).toBe(
      421
    );
    expect(
      (yield* getWithHost(
        port,
        `ridgeline.localhost:${port}`,
        "/../package.json"
      )).status
    ).toBe(404);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
