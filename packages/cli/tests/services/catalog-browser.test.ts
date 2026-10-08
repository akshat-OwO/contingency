import path from "node:path";

import { FlowSkillName, TaskAgentRunSummary } from "@contingency/protocol";
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
import { makeFlowSkillCatalogLayer } from "../../src/services/flow-skill-catalog.ts";
import { taskRunSummary } from "../helpers/task-run.ts";

const skillFile = (name: string, host: string) => `---
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

const VERIFIED = "# Verification\n\n- Verified: 2026-10-01T00:00:00.000Z\n";

const manifest = (recordingId: string, flowSkillName: string) => ({
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
  flowSkillName,
  lifecycle: {
    _tag: "skill-drafted",
    draftedAt: "2026-10-01T00:02:00.000Z",
    readyAt: "2026-10-01T00:01:00.000Z",
    skillPath: flowSkillName,
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

/** A passing Dry Run Summary, kept beside its Teaching Recording. */
const dryRunSummary = (recordingId: string) =>
  encodeSummary(
    Schema.decodeUnknownSync(TaskAgentRunSummary)({
      ...encodeSummary(taskRunSummary),
      inputs: [],
      purpose: {
        flowSkillName: "draft-cart",
        kind: "dry-run",
        recordingId,
        takeoverOccurred: false,
      },
      referencedSkills: [
        {
          flowSkillName: "draft-cart",
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

const writeSkill = (root: string, name: string, verified: boolean) =>
  Effect.gen(function* writeFlowSkill() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.join(root, name);
    yield* fileSystem.makeDirectory(path.join(directory, "references"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      path.join(directory, "SKILL.md"),
      skillFile(name, "shop.example.com")
    );
    if (verified) {
      yield* fileSystem.writeFileString(
        path.join(directory, "references", "verification.md"),
        VERIFIED
      );
    }
  });

/** A local root with a verified skill, a draft, Runs, and one bad Summary. */
const seedLocal = (root: string) =>
  Effect.gen(function* seedLocalRoot() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* writeSkill(root, "browse-catalogue", true);
    yield* writeSkill(root, "draft-cart", false);
    // A directory without SKILL.md is not a Flow Skill and is not listed.
    yield* fileSystem.makeDirectory(path.join(root, "notes"), {
      recursive: true,
    });
    yield* writeJson(
      path.join(root, "agent-runs", taskRunSummary.runId, "summary.json"),
      JSON.stringify(encodeSummary(taskRunSummary))
    );
    yield* writeJson(
      path.join(root, "agent-runs", "agentrun-broken", "summary.json"),
      JSON.stringify({ schemaVersion: 99 })
    );
    // A Run still in progress has no Summary yet and is simply absent.
    yield* fileSystem.makeDirectory(
      path.join(root, "agent-runs", "agentrun-live"),
      { recursive: true }
    );
    const recordingId = "recording-draft-cart";
    yield* writeJson(
      path.join(root, ".recordings", recordingId, "manifest.json"),
      JSON.stringify(manifest(recordingId, "draft-cart"))
    );
    yield* writeJson(
      path.join(root, ".recordings", recordingId, "dry-run", "summary.json"),
      JSON.stringify(dryRunSummary(recordingId))
    );
  });

const browserFor = (localRoot: string, globalRoot?: string) =>
  makeCatalogBrowserLayer({ globalRoot, localRoot: () => localRoot }).pipe(
    Layer.provide(makeFlowSkillCatalogLayer({ root: localRoot }))
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
    yield* writeSkill(global, "staging-login", true);

    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local, global)));

    const [localView, globalView] = result.roots;
    expect(result.roots).toHaveLength(2);
    expect(localView?.scope).toBe("local");
    expect(localView?.present).toBe(true);
    expect(
      localView?.flowSkills.map((skill) => [skill.name, skill.verified])
    ).toEqual([
      ["browse-catalogue", true],
      ["draft-cart", false],
    ]);
    expect(localView?.flowSkills[0]).toMatchObject({
      description: "Add a product to the browse-catalogue cart.",
      hosts: ["shop.example.com"],
      stepCount: 2,
    });
    // Newest first, with the Dry Run read from beside its recording.
    expect(
      localView?.runs.map((run) => [run.runId, run.kind, run.recordingId])
    ).toEqual([
      ["agentrun-dry-run", "dry-run", "recording-draft-cart"],
      [taskRunSummary.runId, "interactive", null],
    ]);
    expect(localView?.runs[1]).toMatchObject({
      assessment: "working",
      flowSkillNames: ["browse-catalogue", "update-cart"],
    });
    expect(localView?.recordings).toEqual([
      {
        cleanup: "pending",
        createdAt: "2026-10-01T00:00:00.000Z",
        flowSkillName: "draft-cart",
        keyframeCount: 1,
        phase: "skill-drafted",
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
    expect(globalView?.flowSkills.map((skill) => skill.name)).toEqual([
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
      flowSkills: [],
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
    yield* writeSkill(local, "browse-catalogue", true);
    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local, path.join(workspace, "nobody"))));
    expect(result.roots[1]).toMatchObject({
      flowSkills: [],
      present: false,
      scope: "global",
    });
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("reads one skill's files and procedure from either root", () =>
  Effect.gen(function* readSkills() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-read-",
    });
    const local = path.join(workspace, "project", ".contingency");
    const global = path.join(workspace, "home", ".contingency");
    yield* writeSkill(local, "browse-catalogue", true);
    yield* writeSkill(global, "staging-login", false);

    const [localSkill, globalSkill, missing] = yield* Effect.gen(
      function* read() {
        const browser = yield* CatalogBrowser;
        return [
          yield* browser.flowSkill(
            "local",
            FlowSkillName.make("browse-catalogue")
          ),
          yield* browser.flowSkill(
            "global",
            FlowSkillName.make("staging-login")
          ),
          yield* Effect.flip(
            browser.flowSkill("local", FlowSkillName.make("staging-login"))
          ),
        ] as const;
      }
    ).pipe(Effect.provide(browserFor(local, global)));

    expect(localSkill.entry).toMatchObject({
      name: "browse-catalogue",
      verified: true,
    });
    expect(localSkill.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/verification.md",
    ]);
    expect(localSkill.steps).toEqual([
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
    expect(globalSkill.entry).toMatchObject({
      name: "staging-login",
      verified: false,
    });
    expect(missing.code).toBe("flow_skill_not_found");
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
        browser.flowSkill("global", FlowSkillName.make("staging-login"))
      );
    }).pipe(Effect.provide(browserFor(local)));
    expect(error.code).toBe("flow_skill_not_found");
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
      yield* writeSkill(local, "browse-catalogue", true);
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
    yield* writeSkill(local, "browse-catalogue", false);
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
    const [listing, skill] = yield* Effect.gen(function* read() {
      const browser = yield* CatalogBrowser;
      return [
        yield* browser.browse(),
        yield* browser.flowSkill(
          "local",
          FlowSkillName.make("browse-catalogue")
        ),
      ] as const;
    }).pipe(Effect.provide(browserFor(local)));
    expect(listing.roots[0]?.flowSkills[0]?.verified).toBe(false);
    expect(skill.entry.verified).toBe(false);
    expect(skill.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("lists a skill as unverified when its stamp cannot be read", () =>
  Effect.gen(function* listUnreadableStamp() {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-browser-unreadable-",
    });
    const local = path.join(workspace, ".contingency");
    yield* writeSkill(local, "browse-catalogue", true);
    yield* writeSkill(local, "update-cart", true);
    yield* fileSystem.chmod(
      path.join(local, "browse-catalogue", "references", "verification.md"),
      0o000
    );
    const result = yield* Effect.gen(function* browse() {
      const browser = yield* CatalogBrowser;
      return yield* browser.browse();
    }).pipe(Effect.provide(browserFor(local)));
    expect(
      result.roots[0]?.flowSkills.map((skill) => [skill.name, skill.verified])
    ).toEqual([
      ["browse-catalogue", false],
      ["update-cart", true],
    ]);
  }).pipe(Effect.provide(NodeServices.layer))
);

/** Three independent JSON documents, alongside the healthy seeded history. */
const extraDocuments = (root: string) =>
  [
    path.join(root, "agent-runs", "agentrun-extra", "summary.json"),
    path.join(root, ".recordings", "recording-extra", "manifest.json"),
    path.join(
      root,
      ".recordings",
      "recording-extra",
      "dry-run",
      "summary.json"
    ),
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
        expect(result.roots[0]?.flowSkills).toHaveLength(2);
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
      yield* writeSkill(global, "staging-login", true);
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
