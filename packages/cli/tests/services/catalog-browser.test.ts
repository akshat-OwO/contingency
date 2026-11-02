import path from "node:path";

import { FlowName, TaskAgentRunSummary } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  PlatformError,
  Schema,
} from "effect";

import {
  CatalogBrowser,
  makeCatalogBrowserLayer,
} from "../../src/services/catalog-browser.ts";
import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import { stampFlowVerification } from "../../src/services/flow-package.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const flowFile = (name: string, host: string) => `---
name: ${name}
description: Add a product to the ${name} cart.
hosts:
  - ${host}
---

1. Open the store.
   Done when: the product list is visible.
2. Add the product.
   Done when: the cart shows one item.
`;

const VERIFIED = {
  completedAt: "2026-10-01",
  inputs: [],
  observableOutcome: "Ready",
  outcome: "passed" as const,
  platform: "web" as const,
  verifiedAt: "2026-10-01",
};

const manifest = (recordingId: string, flowName: string) => ({
  artifacts: [
    {
      capturedAt: "2026-10-01T00:00:10.000Z",
      hash: `sha256-${"a".repeat(64)}`,
      id: "keyframe-one",
      kind: "keyframe",
      path: "keyframe-one.png",
    },
    {
      capturedAt: "2026-10-01T00:00:10.000Z",
      hash: `sha256-${"b".repeat(64)}`,
      id: "events",
      kind: "events",
      path: "events.jsonl",
    },
  ],
  cleanup: { _tag: "pending" },
  createdAt: "2026-10-01T00:00:00.000Z",
  emulation: {
    permissions: [],
    userAgentProfile: "default",
    viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
  },
  flowName,
  lifecycle: {
    _tag: "flow-drafted",
    draftedAt: "2026-10-01T00:02:00.000Z",
    readyAt: "2026-10-01T00:01:00.000Z",
    startedAt: "2026-10-01T00:00:05.000Z",
    stoppedAt: "2026-10-01T00:00:55.000Z",
  },
  receipts: [],
  recordingId,
  schemaVersion: 1,
  sessionId: "agent-teaching",
  updatedAt: "2026-10-01T00:02:00.000Z",
});

const encodeSummary = Schema.encodeSync(TaskAgentRunSummary);

/** A passing Dry Run Summary, kept in its Flow runs directory. */
const dryRunSummary = (recordingId: string) =>
  encodeSummary(
    Schema.decodeUnknownSync(TaskAgentRunSummary)({
      ...encodeSummary(taskRunSummary),
      inputs: [],
      purpose: {
        flowName: "draft-cart",
        kind: "dry-run",
        recordingId,
        takeoverOccurred: false,
      },
      referencedFlows: [
        {
          flowName: "draft-cart",
          referencedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      runId: "agentrun-dry-run",
      startedAt: "2026-10-02T00:00:00.000Z",
      title: "Dry Run draft-cart",
      variables: [],
    })
  );

const writeJson = (file: string, contents: string) =>
  Effect.gen(function* writeDocument() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  });

const writeFlow = (root: string, name: string, verified: boolean) =>
  Effect.gen(function* writeCatalogFlow() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.join(root, name);
    yield* fileSystem.makeDirectory(path.join(directory, "references"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      path.join(directory, "flow.md"),
      verified
        ? stampFlowVerification(flowFile(name, "shop.example.com"), VERIFIED)
        : flowFile(name, "shop.example.com")
    );
  });

/** A local root with a verified flow, a draft, Runs, and one bad Summary. */
const seedLocal = (root: string) =>
  Effect.gen(function* seedLocalRoot() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* writeFlow(root, "browse-catalogue", true);
    yield* writeFlow(root, "draft-cart", false);
    // A directory without flow.md is not a Flow and is not listed.
    yield* fileSystem.makeDirectory(path.join(root, "notes"), {
      recursive: true,
    });
    yield* writeJson(
      path.join(root, "runs", taskRunSummary.runId, "summary.json"),
      JSON.stringify(encodeSummary(taskRunSummary))
    );
    yield* writeJson(
      path.join(root, "runs", "agentrun-broken", "summary.json"),
      JSON.stringify({ schemaVersion: 99 })
    );
    // A Run still in progress has no Summary yet and is simply absent.
    yield* fileSystem.makeDirectory(path.join(root, "runs", "agentrun-live"), {
      recursive: true,
    });
    const recordingId = "recording-draft-cart";
    yield* writeJson(
      path.join(root, "draft-cart", "recordings", recordingId, "manifest.json"),
      JSON.stringify(manifest(recordingId, "draft-cart"))
    );
    yield* writeJson(
      path.join(root, "draft-cart", "runs", "agentrun-dry-run", "summary.json"),
      JSON.stringify(dryRunSummary(recordingId))
    );
  });

const browserFor = (localRoot: string, globalRoot?: string) =>
  makeCatalogBrowserLayer({ globalRoot, localRoot: () => localRoot }).pipe(
    Layer.provide(makeFlowCatalogLayer({ root: localRoot }))
  );

it.effect("lists the local root first and the global root after it", () =>
  Effect.gen(function* listBothRoots() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-",
    });
    const local = path.join(workspace, "project", ".contingency");
    const global = path.join(workspace, "home", ".contingency");
    yield* seedLocal(local);
    yield* writeFlow(global, "staging-login", true);

    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local, global)));

    const [localView, globalView] = result.roots;
    expect(result.roots).toHaveLength(2);
    expect(localView?.scope).toBe("local");
    expect(localView?.present).toBe(true);
    expect(localView?.flows.map((flow) => [flow.name, flow.verified])).toEqual([
      ["browse-catalogue", true],
      ["draft-cart", false],
    ]);
    expect(localView?.flows[0]).toMatchObject({
      description: "Add a product to the browse-catalogue cart.",
      hosts: ["shop.example.com"],
      stepCount: 2,
    });
    // Newest first, with the Dry Run read from the Flow.
    expect(
      localView?.runs.map((run) => [run.runId, run.kind, run.recordingId])
    ).toEqual([
      ["agentrun-dry-run", "dry-run", "recording-draft-cart"],
      [taskRunSummary.runId, "interactive", null],
    ]);
    expect(localView?.runs[1]).toMatchObject({
      assessment: "working",
      flowNames: ["browse-catalogue", "update-cart"],
    });
    expect(localView?.recordings).toEqual([
      {
        cleanup: "pending",
        createdAt: "2026-10-01T00:00:00.000Z",
        flowName: "draft-cart",
        keyframeCount: 1,
        ownerFlow: "draft-cart",
        phase: "flow-drafted",
        recordingId: "recording-draft-cart",
      },
    ]);
    expect(localView?.unreadable).toBe(1);
    expect(globalView).toMatchObject({
      path: global,
      present: true,
      recordings: [],
      runs: [],
      scope: "global",
    });
    expect(globalView?.flows.map((flow) => flow.name)).toEqual([
      "staging-login",
    ]);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("lists one root when the global root is the local one", () =>
  Effect.gen(function* listOneRoot() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-same-",
    });
    const root = path.join(workspace, ".contingency");
    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(root, `${root}${path.sep}`)));
    expect(result.roots.map((view) => view.scope)).toEqual(["local"]);
    expect(result.roots[0]).toMatchObject({
      flows: [],
      present: false,
      unreadable: 0,
    });
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("reports a missing global root as absent rather than failing", () =>
  Effect.gen(function* listAbsentGlobal() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-absent-",
    });
    const local = path.join(workspace, "project", ".contingency");
    yield* writeFlow(local, "browse-catalogue", true);
    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local, path.join(workspace, "nobody"))));
    expect(result.roots[1]).toMatchObject({
      flows: [],
      present: false,
      scope: "global",
    });
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("reads one flow's files and procedure from either root", () =>
  Effect.gen(function* readFlows() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-read-",
    });
    const local = path.join(workspace, "project", ".contingency");
    const global = path.join(workspace, "home", ".contingency");
    yield* writeFlow(local, "browse-catalogue", true);
    yield* writeFlow(global, "staging-login", false);

    const [localFlow, globalFlow, missing] = yield* Effect.gen(
      function* read() {
        const browser = yield* CatalogBrowser;
        return [
          yield* browser.flow("local", FlowName.make("browse-catalogue")),
          yield* browser.flow("global", FlowName.make("staging-login")),
          yield* Effect.flip(
            browser.flow("local", FlowName.make("staging-login"))
          ),
        ] as const;
      }
    ).pipe(Effect.provide(browserFor(local, global)));

    expect(localFlow.entry).toMatchObject({
      name: "browse-catalogue",
      verified: true,
    });
    expect(localFlow.files.map((file) => file.path)).toEqual(["flow.md"]);
    expect(localFlow.steps).toEqual([
      {
        description:
          "1. Open the store.\n   Done when: the product list is visible.",
        doneWhen: "the product list is visible.",
        name: "Open the store.",
      },
      {
        description:
          "2. Add the product.\n   Done when: the cart shows one item.",
        doneWhen: "the cart shows one item.",
        name: "Add the product.",
      },
    ]);
    expect(globalFlow.entry).toMatchObject({
      name: "staging-login",
      verified: false,
    });
    expect(missing.code).toBe("flow_not_found");
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("refuses the global scope when no global root is listed", () =>
  Effect.gen(function* refuseGlobal() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-no-global-",
    });
    const local = path.join(workspace, ".contingency");
    const error = yield* Effect.gen(function* read() {
      const browser = yield* CatalogBrowser;
      return yield* Effect.flip(
        browser.flow("global", FlowName.make("staging-login"))
      );
    }).pipe(Effect.provide(browserFor(local)));
    expect(error.code).toBe("flow_not_found");
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "lists one root when the global root is a symlink to the local one",
  () =>
    Effect.gen(function* listLinkedRoot() {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-catalog-browser-linked-",
      });
      const local = path.join(workspace, "project", ".contingency");
      yield* writeFlow(local, "browse-catalogue", true);
      const linked = path.join(workspace, "home-contingency");
      yield* fileSystem.symlink(local, linked);
      const result = yield* Effect.gen(function* browse() {
        const browser = yield* CatalogBrowser;
        return yield* browser.browse();
      }).pipe(Effect.provide(browserFor(local, linked)));
      expect(result.roots.map((view) => view.scope)).toEqual(["local"]);
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("leaves out a reference that links outside its package", () =>
  Effect.gen(function* skipEscapingLink() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-escape-",
    });
    const local = path.join(workspace, "project", ".contingency");
    yield* writeFlow(local, "browse-catalogue", false);
    const outside = path.join(workspace, "secret.md");
    yield* fileSystem.writeFileString(
      outside,
      "# Not part of the package\n\n- Verified: forged\n"
    );
    yield* fileSystem.symlink(
      outside,
      path.join(local, "browse-catalogue", "references", "verification.md")
    );
    yield* fileSystem.symlink(
      outside,
      path.join(local, "browse-catalogue", "references", "notes.md")
    );
    const [listing, flow] = yield* Effect.gen(function* read() {
      const browser = yield* CatalogBrowser;
      return [
        yield* browser.browse(),
        yield* browser.flow("local", FlowName.make("browse-catalogue")),
      ] as const;
    }).pipe(Effect.provide(browserFor(local)));
    expect(listing.roots[0]?.flows[0]?.verified).toBe(false);
    expect(flow.entry.verified).toBe(false);
    expect(flow.files.map((file) => file.path)).toEqual(["flow.md"]);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("lists a Flow as unverified when its stamp is malformed", () =>
  Effect.gen(function* listUnreadableStamp() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-unreadable-",
    });
    const local = path.join(workspace, ".contingency");
    yield* writeFlow(local, "browse-catalogue", true);
    yield* writeFlow(local, "update-cart", true);
    yield* fileSystem.writeFileString(
      path.join(local, "browse-catalogue", "flow.md"),
      flowFile("browse-catalogue", "shop.example.com").replace(
        "---\nname:",
        "---\nverification: broken\nname:"
      )
    );
    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local)));
    expect(
      result.roots[0]?.flows.map((flow) => [flow.name, flow.verified])
    ).toEqual([
      ["browse-catalogue", false],
      ["update-cart", true],
    ]);
  }).pipe(Effect.provide(NodeServices.layer))
);

/** Three independent JSON documents, alongside the healthy seeded history. */
const extraDocuments = (root: string) =>
  [
    path.join(root, "runs", "agentrun-extra", "summary.json"),
    path.join(
      root,
      "draft-cart",
      "recordings",
      "recording-extra",
      "manifest.json"
    ),
    path.join(root, "draft-cart", "runs", "agentrun-extra-dry", "summary.json"),
  ] as const;

const seedExtraDocuments = (root: string) =>
  Effect.gen(function* seedDocuments() {
    yield* seedLocal(root);
    const [run, recording, dryRun] = extraDocuments(root);
    yield* writeJson(run, JSON.stringify(encodeSummary(taskRunSummary)));
    yield* writeJson(
      recording,
      JSON.stringify(manifest("recording-extra", "draft-cart"))
    );
    yield* writeJson(dryRun, JSON.stringify(dryRunSummary("recording-extra")));
  });

const browseWith = (
  root: string,
  fileSystem: FileSystem.FileSystem,
  global?: string
) =>
  Effect.gen(function* browseAdapted() {
    const browser = yield* CatalogBrowser;
    return yield* browser.browse();
  }).pipe(
    Effect.provide(browserFor(root, global)),
    Effect.provideService(FileSystem.FileSystem, fileSystem)
  );

for (const reason of ["PermissionDenied", "Busy", "Unknown"] as const) {
  it.effect(
    `counts ${reason} JSON read failures once and keeps healthy neighbors`,
    () =>
      Effect.gen(function* typedReadFailures() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* seedExtraDocuments(root);
        const targets = extraDocuments(root);
        const result = yield* browseWith(root, {
          ...fs,
          readFileString: (file, encoding) =>
            targets.includes(file)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: reason,
                    method: "readFileString",
                    module: "FileSystem",
                  })
                )
              : fs.readFileString(file, encoding),
        });
        expect(result.roots[0]?.unreadable).toBe(4);
        expect(result.roots[0]?.flows).toHaveLength(2);
        expect(result.roots[0]?.runs).toHaveLength(2);
        expect(result.roots[0]?.recordings).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer))
  );
}

it.effect("treats deletion at read time as absent on every JSON path", () =>
  Effect.gen(function* readRaces() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* seedExtraDocuments(root);
    const targets = extraDocuments(root);
    const result = yield* browseWith(root, {
      ...fs,
      readFileString: (file, encoding) =>
        Effect.gen(function* deleteBeforeRead() {
          if (targets.includes(file)) {
            yield* fs.remove(file);
          }
          return yield* fs.readFileString(file, encoding);
        }),
    });
    expect(result.roots[0]?.unreadable).toBe(1);
    expect(result.roots[0]?.runs).toHaveLength(2);
    expect(result.roots[0]?.recordings).toHaveLength(1);
    for (const target of targets) {
      expect(yield* fs.exists(target)).toBe(false);
    }
  }).pipe(Effect.provide(NodeServices.layer))
);

for (const contents of ["{", '{"schemaVersion":99}']) {
  it.effect(
    `counts each malformed JSON or schema document once: ${contents}`,
    () =>
      Effect.gen(function* invalidDocuments() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* seedExtraDocuments(root);
        for (const file of extraDocuments(root)) {
          yield* fs.writeFileString(file, contents);
        }
        const result = yield* browseWith(root, fs);
        expect(result.roots[0]?.unreadable).toBe(4);
        expect(result.roots[0]?.runs).toHaveLength(2);
        expect(result.roots[0]?.recordings).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer))
  );
}

for (const failure of ["defect", "interruption"] as const) {
  it.effect(`preserves ${failure} from each JSON read`, () =>
    Effect.gen(function* preserveCause() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* seedExtraDocuments(root);
      for (const target of extraDocuments(root)) {
        const result = yield* Effect.exit(
          browseWith(root, {
            ...fs,
            readFileString: (file, encoding) => {
              if (file !== target) {
                return fs.readFileString(file, encoding);
              }
              return failure === "defect"
                ? Effect.die("read defect")
                : Effect.interrupt;
            },
          })
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(
            failure === "defect"
              ? Cause.hasDies(result.cause)
              : Cause.hasInterrupts(result.cause)
          ).toBe(true);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer))
  );
}

for (const scope of ["local", "global"] as const) {
  it.effect(`keeps ${scope} root enumeration failures fatal`, () =>
    Effect.gen(function* fatalRoot() {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      const local = path.join(workspace, "local");
      const global = path.join(workspace, "global");
      yield* seedLocal(local);
      yield* writeFlow(global, "staging-login", true);
      const target = scope === "local" ? local : global;
      const error = yield* Effect.flip(
        browseWith(
          local,
          {
            ...fs,
            readDirectory: (directory, options) =>
              directory === target
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      method: "readDirectory",
                      module: "FileSystem",
                    })
                  )
                : fs.readDirectory(directory, options),
          },
          global
        )
      );
      expect(error).toMatchObject({
        _tag: "CatalogBrowserError",
        code: "catalog_io",
      });
    }).pipe(Effect.provide(NodeServices.layer))
  );
}

it.effect("finds task Runs in a grouped Flow alongside root history", () =>
  Effect.gen(function* groupedRunHistory() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* writeFlow(path.join(root, "shop"), "checkout", true);
    const flowRun = {
      ...encodeSummary(taskRunSummary),
      runId: "agentrun-flow-local",
    };
    yield* writeJson(
      path.join(
        root,
        "shop",
        "checkout",
        "runs",
        flowRun.runId,
        "summary.json"
      ),
      JSON.stringify(flowRun)
    );
    yield* writeJson(
      path.join(root, "runs", taskRunSummary.runId, "summary.json"),
      JSON.stringify(encodeSummary(taskRunSummary))
    );
    yield* writeJson(
      path.join(root, "shop", "checkout", "runs", "broken", "summary.json"),
      "{}"
    );
    const result = yield* Effect.gen(function* browse() {
      return yield* (yield* CatalogBrowser).browse();
    }).pipe(Effect.provide(browserFor(root)));
    expect(
      result.roots[0]?.runs.map((run) => [run.runId, run.kind, run.recordingId])
    ).toEqual(
      expect.arrayContaining([
        ["agentrun-flow-local", "interactive", null],
        [taskRunSummary.runId, "interactive", null],
      ])
    );
    expect(result.roots[0]?.runs).toHaveLength(2);
    expect(result.roots[0]?.unreadable).toBe(1);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "preserves Group paths and storage ownership independently of references",
  () =>
    Effect.gen(function* groupedCatalog() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "contingency-groups-",
      });
      yield* seedLocal(root);
      yield* fs.makeDirectory(path.join(root, "Commerce", "Checkout"), {
        recursive: true,
      });
      yield* fs.rename(
        path.join(root, "draft-cart"),
        path.join(root, "Commerce", "Checkout", "draft-cart")
      );
      const result = yield* Effect.gen(function* browse() {
        return yield* (yield* CatalogBrowser).browse();
      }).pipe(Effect.provide(browserFor(root)));
      const [view] = result.roots;
      expect(
        view?.flows.find((flow) => flow.name === "draft-cart")?.groupPath
      ).toEqual(["Commerce", "Checkout"]);
      expect(
        view?.runs.find((entry) => entry.runId === taskRunSummary.runId)
          ?.ownerFlow
      ).toBeNull();
      expect(
        view?.runs.find((entry) => entry.runId === "agentrun-dry-run")
          ?.ownerFlow
      ).toBe("draft-cart");
      expect(view?.recordings[0]?.ownerFlow).toBe("draft-cart");
    }).pipe(Effect.provide(NodeServices.layer))
);
