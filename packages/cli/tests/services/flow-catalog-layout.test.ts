import path from "node:path";

import { FlowName } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import {
  CatalogBrowser,
  makeCatalogBrowserLayer,
} from "../../src/services/catalog-browser.ts";
import {
  discoverFlows,
  resolveFlowDirectory,
} from "../../src/services/flow-catalog-layout.ts";
import {
  FlowCatalog,
  makeFlowCatalogLayer,
} from "../../src/services/flow-catalog.ts";

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
      yield* writeFlow(root, "runs/run/hidden");
      yield* writeFlow(root, "shop/checkout/guest/recordings/hidden");
      yield* Effect.gen(function* read() {
        const catalog = yield* FlowCatalog;
        expect(
          (yield* catalog.list()).flows.map((entry) => entry.name)
        ).toEqual(["guest"]);
        expect((yield* catalog.read("guest")).directory).toBe(
          path.join(root, "shop/checkout/guest")
        );
      }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("refuses duplicate names with both paths", () =>
  Effect.gen(function* test() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* writeFlow(root, "first/guest");
    yield* writeFlow(root, "second/guest");
    yield* Effect.gen(function* read() {
      const catalog = yield* FlowCatalog;
      for (const operation of [
        catalog.list().pipe(Effect.asVoid),
        catalog.read("guest").pipe(Effect.asVoid),
      ]) {
        const error = yield* Effect.flip(operation);
        expect(error.message).toContain(path.join(root, "first/guest"));
        expect(error.message).toContain(path.join(root, "second/guest"));
      }
    }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
  }).pipe(Effect.provide(NodeServices.layer))
);

for (const relative of [
  "invalid+name",
  "flow.md",
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
        const catalog = yield* FlowCatalog;
        const error = yield* Effect.flip(catalog.list());
        expect(error.code).toBe("agent_catalog_invalid");
        expect(error.message).toContain(
          path.join(root, relative.split("/")[0] ?? "")
        );
      }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
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
        const catalog = yield* FlowCatalog;
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
      }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("discovers Flows in every ordinary Group", () =>
  Effect.gen(function* test() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* writeFlow(root, "group/ordinary");
    yield* writeFlow(root, "another/visible");
    yield* Effect.gen(function* read() {
      const catalog = yield* FlowCatalog;
      expect((yield* catalog.list()).flows.map((flow) => flow.name)).toEqual([
        "ordinary",
        "visible",
      ]);
    }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "keeps recording drafts as owners but excludes them from both listings and reads",
  () =>
    Effect.gen(function* draftOwnership() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(root, "shop", "checkout");
      yield* fs.makeDirectory(path.join(directory, "recordings"), {
        recursive: true,
      });
      expect((yield* discoverFlows(root, fs)).get("checkout")).toEqual({
        directory,
        kind: "draft",
      });
      expect(
        yield* resolveFlowDirectory(root, FlowName.make("checkout"), fs)
      ).toBe(directory);
      yield* Effect.gen(function* listings() {
        const catalog = yield* FlowCatalog;
        expect((yield* catalog.list()).flows).toEqual([]);
        expect((yield* Effect.flip(catalog.read("checkout"))).code).toBe(
          "flow_not_found"
        );
      }).pipe(Effect.provide(makeFlowCatalogLayer({ root })));
      yield* Effect.gen(function* workspaceListing() {
        const browser = yield* CatalogBrowser;
        expect((yield* browser.browse()).roots[0]?.flows).toEqual([]);
        expect(
          (yield* Effect.flip(browser.flow("local", FlowName.make("checkout"))))
            .code
        ).toBe("flow_not_found");
      }).pipe(
        Effect.provide(
          makeCatalogBrowserLayer({
            globalRoot: root,
            localRoot: () => root,
          }).pipe(Layer.provide(makeFlowCatalogLayer({ root })))
        )
      );
      yield* writeFlow(root, "other/checkout");
      const collision = yield* Effect.flip(discoverFlows(root, fs));
      expect(collision.message).toContain("Duplicate Flow name");
      expect(collision.message).toContain(directory);
    }).pipe(Effect.provide(NodeServices.layer))
);
