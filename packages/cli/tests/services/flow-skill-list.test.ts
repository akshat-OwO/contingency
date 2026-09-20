import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

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
    yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), SKILL);

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
      },
    ]);
    // The Catalog Root is the MCP process's business, not the caller's.
    expect(JSON.stringify(listing)).not.toContain(root);
    expect(JSON.stringify(listing)).not.toContain(path.sep);
  }).pipe(Effect.provide(NodeServices.layer))
);
