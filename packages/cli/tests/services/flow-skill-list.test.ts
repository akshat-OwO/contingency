import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { flowDocuments } from "../../src/services/flow-documents.ts";
import {
  FlowSkillCatalog,
  makeFlowSkillCatalogLayer,
} from "../../src/services/flow-skill-catalog.ts";

const SKILL = `---
name: set-delivery-area
description: Set the delivery area for a store.
inputs:
  - name: area
    description: The delivery area to set.
---

# Set the delivery area

1. Choose the button named "Delivery area".
   Done when: the delivery area panel is open.
2. Enter {{area}} into the field named "Area".
   Done when: the field holds the area.
`;

it.effect("lists a Flow Skill without naming the Catalog Root", () =>
  Effect.gen(function* listWithoutPaths() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-flow-skill-list-",
    });
    const directory = path.join(root, "set-delivery-area");
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, "flow.md"), SKILL);

    const listing = yield* Effect.gen(function* readListing() {
      const catalog = yield* FlowSkillCatalog;
      return yield* catalog.list();
    }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));

    expect(listing.flowSkills).toEqual([
      {
        description: "Set the delivery area for a store.",
        inputs: [{ description: "The delivery area to set.", name: "area" }],
        name: "set-delivery-area",
        stepCount: 2,
        verified: false,
      },
    ]);
    // The Catalog Root is the MCP process's business, not the caller's.
    expect(JSON.stringify(listing)).not.toContain(root);
    expect(JSON.stringify(listing)).not.toContain(path.sep);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "leaves a reference that links outside its package out of a read",
  () =>
    Effect.gen(function* readWithoutEscapingLink() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-flow-skill-escape-",
      });
      const directory = path.join(root, "set-delivery-area");
      yield* fileSystem.makeDirectory(path.join(directory, "references"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(path.join(directory, "flow.md"), SKILL);
      yield* fileSystem.writeFileString(
        path.join(directory, "targets.md"),
        "# Accessibility\n"
      );
      const outside = path.join(root, "outside.md");
      yield* fileSystem.writeFileString(outside, "# Elsewhere\n");
      yield* fileSystem.symlink(
        outside,
        path.join(directory, "references", "linked.md")
      );

      const skill = yield* Effect.gen(function* readSkill() {
        const catalog = yield* FlowSkillCatalog;
        return yield* catalog.read("set-delivery-area");
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));

      expect(skill.files.map((file) => file.path)).toEqual([
        "flow.md",
        "targets.md",
      ]);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "discovers supporting markdown at depth and refuses document escapes",
  () =>
    Effect.gen(function* supportingDocuments() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(root, "set-delivery-area");
      const files = [
        { content: SKILL, path: "flow.md" },
        {
          content: "Intro\n\n## Starting state\nSecret body",
          path: "setup.md",
        },
        { content: "Rules\n=====\nBody", path: "knowledge/deep/rules.md" },
        { content: "{{undeclared}}", path: "knowledge/notes.txt" },
        { content: "# Run evidence", path: "runs/private.md" },
        { content: "# Teaching evidence", path: "recordings/private.md" },
        { content: "# Nested evidence", path: "knowledge/runs/private.md" },
      ];
      for (const file of files) {
        const target = path.join(directory, file.path);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, file.content);
      }
      yield* fs.symlink(
        path.join(directory, "runs/private.md"),
        path.join(directory, "leak.md")
      );
      yield* fs.writeFileString(path.join(root, "outside.md"), "# Outside");
      yield* fs.symlink(
        path.join(root, "outside.md"),
        path.join(directory, "outside.md")
      );
      yield* Effect.gen(function* readDocuments() {
        const catalog = yield* FlowSkillCatalog;
        const skill = yield* catalog.read("set-delivery-area");
        expect(skill.files.map((file) => file.path)).toEqual([
          "flow.md",
          "knowledge/deep/rules.md",
          "setup.md",
        ]);
        expect(flowDocuments(skill.files)).toEqual({
          files: [{ content: SKILL, path: "flow.md" }],
          supportingDocuments: [
            { heading: "Rules", path: "knowledge/deep/rules.md" },
            { heading: "Starting state", path: "setup.md" },
          ],
        });
        expect(
          yield* catalog.readDocument("set-delivery-area", "setup.md")
        ).toEqual(files[1]);
        for (const documentPath of [
          "../outside.md",
          "/outside.md",
          "knowledge/../../outside.md",
          "runs/private.md",
          "recordings/private.md",
          "knowledge/runs/private.md",
          "leak.md",
          "outside.md",
          "knowledge/notes.txt",
          "flow.md",
          "knowledge\\rules.md",
        ]) {
          const error = yield* Effect.flip(
            catalog.readDocument("set-delivery-area", documentPath)
          );
          expect(error.code).toBe("agent_catalog_invalid");
        }
      }).pipe(Effect.provide(makeFlowSkillCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);
