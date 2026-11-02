import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  FlowSkillCatalog,
  makeFlowSkillCatalogLayer,
} from "../../src/services/flow-skill-catalog.ts";

const document = (name: string) =>
  `---\nname: ${name}\ndescription: Complete the journey.\n---\n1. Open the store.\n   Done when: the store is visible.\n`;

const writeFlow = (root: string, relative: string) =>
  Effect.gen(function* write() {
    const fs = yield* FileSystem.FileSystem;
    const directory = path.join(root, relative);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "flow.md"),
      document(path.basename(relative))
    );
  });

it.effect(
  "discovers and reads Flows through Groups at any depth, excluding legacy and evidence",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      const root = path.join(workspace, "contingency");
      yield* writeFlow(root, "shop/checkout/guest");
      yield* writeFlow(workspace, ".contingency/legacy");
      yield* writeFlow(root, ".recordings/recording/hidden");
      yield* writeFlow(root, "agent-runs/run/hidden");
      yield* Effect.gen(function* read() {
        const catalog = yield* FlowSkillCatalog;
        expect(
          (yield* catalog.list()).flowSkills.map((entry) => entry.name)
        ).toEqual(["guest"]);
        expect((yield* catalog.read("guest")).directory).toBe(
          path.join(root, "shop/checkout/guest")
        );
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("refuses duplicate names with both paths", () =>
  Effect.gen(function* test() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* writeFlow(root, "first/guest");
    yield* writeFlow(root, "second/guest");
    yield* Effect.gen(function* read() {
      const catalog = yield* FlowSkillCatalog;
      for (const operation of [
        catalog.list().pipe(Effect.asVoid),
        catalog.read("guest").pipe(Effect.asVoid),
      ]) {
        const error = yield* Effect.flip(operation);
        expect(error.message).toContain(path.join(root, "first/guest"));
        expect(error.message).toContain(path.join(root, "second/guest"));
      }
    }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
  }).pipe(Effect.provide(NodeServices.layer))
);

for (const relative of [
  "invalid+name",
  "runs",
  "recordings",
  "flow.md",
  "runs/guest",
  "recordings/guest",
  "flow.md/guest",
  "parent/child",
]) {
  it.effect(`refuses reserved Groups and nested Flows: ${relative}`, () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      if (relative === "parent/child") {
        yield* writeFlow(root, "parent");
      }
      yield* writeFlow(root, relative);
      yield* Effect.gen(function* read() {
        const catalog = yield* FlowSkillCatalog;
        const error = yield* Effect.flip(catalog.list());
        expect(error.code).toBe("agent_catalog_invalid");
        expect(error.message).toContain(
          path.join(root, relative.split("/")[0] ?? "")
        );
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
  );
}

it.effect(
  "creates and maintains catalog evidence ignores without losing custom rules",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      const root = path.join(workspace, "contingency");
      yield* Effect.gen(function* select() {
        const catalog = yield* FlowSkillCatalog;
        yield* catalog.select(root);
        const ignore = path.join(root, ".gitignore");
        expect(yield* fs.readFileString(ignore)).toContain(
          "**/runs/\n**/recordings/\n"
        );
        yield* fs.writeFileString(ignore, "custom/\n**/runs/\n");
        yield* catalog.select(root);
        const maintained = yield* fs.readFileString(ignore);
        expect(maintained).toContain("custom/\n");
        expect(maintained.match(/\*\*\/runs\//gu)).toHaveLength(1);
        expect(maintained).toContain("**/recordings/\n");
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "allows an agent-runs Flow inside a Group while excluding root evidence",
  () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* writeFlow(root, "group/agent-runs");
      yield* writeFlow(root, "agent-runs/hidden");
      yield* Effect.gen(function* read() {
        const catalog = yield* FlowSkillCatalog;
        expect(
          (yield* catalog.list()).flowSkills.map((flow) => flow.name)
        ).toEqual(["agent-runs"]);
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);
