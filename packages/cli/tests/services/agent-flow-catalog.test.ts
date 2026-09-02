import path from "node:path";

import {
  AgentFlowId,
  AgentFlowRevisionId,
  AgentSessionId,
  OperationId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  AgentFlowDraftProposal,
  EvidenceSlice,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";

import {
  AGENT_FLOWS_DIRECTORY,
  AgentFlowCatalog,
  canonicalJson,
  defaultCatalogRoot,
  evidenceHash,
  makeAgentFlowCatalogLayer,
} from "../../src/services/agent-flow-catalog.ts";
import type {
  AgentFlowCatalogService,
  SaveDraftInput,
} from "../../src/services/agent-flow-catalog.ts";

const at = "2026-09-01T00:00:00.000Z";

const slice = (name: string, url: string): EvidenceSlice => ({
  actions: [
    {
      action: { type: "navigate", url },
      actor: "agent",
      at,
      description: `Navigate to ${url}`,
      id: `action-${name}`,
      outcome: "completed",
      snapshotAfter: null,
      snapshotBefore: null,
      urlAfter: url,
      urlBefore: "about:blank",
    },
  ],
  after: null,
  before: null,
  endedAt: at,
  instructions: [],
  schemaVersion: 1,
  screenshots: [],
  startedAt: at,
  urlTransitions: [],
});

const proposal = (
  title: string,
  overrides: Partial<AgentFlowDraftProposal> = {}
): AgentFlowDraftProposal => ({
  description: `${title} across the public shop.`,
  domainScope: { hosts: ["shop.example.com"] },
  schemaVersion: 1,
  steps: [
    {
      confirmation: false,
      description: "Open the shop front page.",
      firstActionId: "action-open",
      lastActionId: "action-open",
      name: "Open the shop",
    },
  ],
  tags: ["shop"],
  title,
  ...overrides,
});

const saveInput = (
  title: string,
  operationId: string,
  overrides: Partial<SaveDraftInput> = {}
): SaveDraftInput => ({
  basedOnRevisionId: null,
  compiler: { clientName: "test-agent", clientVersion: "1" },
  emulation: {
    permissions: [],
    userAgentProfile: UserAgentProfileId.make("default"),
    viewport: { deviceScaleFactor: 1, height: 480, width: 640 },
  },
  operationId: OperationId.make(operationId),
  proposal: proposal(title),
  slices: [slice("Open the shop", "https://shop.example.com/")],
  sourceSessionId: AgentSessionId.make("agent-teaching"),
  ...overrides,
});

const withCatalog = <A, E>(
  use: (
    catalog: AgentFlowCatalogService,
    root: string,
    fileSystem: FileSystem.FileSystem
  ) => Effect.Effect<A, E>
) =>
  Effect.gen(function* useTemporaryCatalog() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-catalog-",
    });
    const context = yield* Layer.build(
      makeAgentFlowCatalogLayer({ now: () => new Date(at), root }).pipe(
        Layer.provide(NodeServices.layer)
      )
    );
    return yield* use(Context.get(context, AgentFlowCatalog), root, fileSystem);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("saves a draft as an inspectable revision package", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* saveDraftPackage() {
      const saved = yield* catalog.saveDraft(saveInput("Shop front", "save-1"));
      expect(saved.manifest.status).toBe("draft");
      expect(saved.manifest.basedOnRevisionId).toBeNull();
      expect(saved.heads.draftRevisionId).toBe(saved.manifest.revisionId);
      expect(saved.heads.approvedRevisionId).toBeNull();
      expect(saved.path).toBe(
        path.join(
          root,
          AGENT_FLOWS_DIRECTORY,
          saved.manifest.agentFlowId,
          "revisions",
          saved.manifest.revisionId
        )
      );

      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(saved.path, "manifest.json"))
      ) as unknown;
      expect(manifest).toEqual(saved.manifest);
      const [step] = saved.manifest.steps;
      expect(step?.evidence.hash).toBe(
        evidenceHash(slice("Open the shop", "https://shop.example.com/"))
      );
      const evidence = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(
            root,
            AGENT_FLOWS_DIRECTORY,
            saved.manifest.agentFlowId,
            step?.evidence.path ?? ""
          )
        )
      ) as unknown;
      expect(evidence).toEqual(
        slice("Open the shop", "https://shop.example.com/")
      );

      const read = yield* catalog.get(saved.manifest.agentFlowId);
      expect(read).toEqual(saved);
      expect(yield* catalog.info()).toEqual({ agentFlowCount: 1, root });
    })
  )
);

it.effect("replays an operation id and refuses its reuse", () =>
  withCatalog((catalog) =>
    Effect.gen(function* idempotentSave() {
      const input = saveInput("Shop front", "save-once");
      const saved = yield* catalog.saveDraft(input);
      const replayed = yield* catalog.saveDraft(input);
      expect(replayed).toEqual(saved);
      expect((yield* catalog.info()).agentFlowCount).toBe(1);

      const conflict = yield* Effect.flip(
        catalog.saveDraft({ ...input, proposal: proposal("Other title") })
      );
      expect(conflict.code).toBe("agent_flow_conflict");
      expect((yield* catalog.info()).agentFlowCount).toBe(1);
    })
  )
);

it.effect("replays a completed save after the catalog service restarts", () =>
  withCatalog((catalog, root) =>
    Effect.gen(function* restartSafeSave() {
      const input = saveInput("Restart safe", "save-restart");
      const saved = yield* catalog.saveDraft(input);
      yield* Effect.scoped(
        Effect.gen(function* useRestartedCatalog() {
          const restartedContext = yield* Layer.build(
            makeAgentFlowCatalogLayer({ root }).pipe(
              Layer.provide(NodeServices.layer)
            )
          );
          const restarted = Context.get(restartedContext, AgentFlowCatalog);
          expect(yield* restarted.saveDraft(input)).toEqual(saved);

          const conflict = yield* Effect.flip(
            restarted.saveDraft({ ...input, proposal: proposal("Different") })
          );
          expect(conflict.code).toBe("agent_flow_conflict");
          expect((yield* restarted.info()).agentFlowCount).toBe(1);
        })
      );
    })
  )
);

it.effect("revises a draft only from its current head", () =>
  withCatalog((catalog) =>
    Effect.gen(function* optimisticConcurrency() {
      const first = yield* catalog.saveDraft(saveInput("Shop front", "rev-1"));
      const id = first.manifest.agentFlowId;

      const stale = yield* Effect.flip(
        catalog.saveDraft(
          saveInput("Shop front, renamed", "rev-stale", {
            agentFlowId: id,
            basedOnRevisionId: null,
          })
        )
      );
      expect(stale.code).toBe("agent_flow_conflict");

      const second = yield* catalog.saveDraft(
        saveInput("Shop front, renamed", "rev-2", {
          agentFlowId: id,
          basedOnRevisionId: first.manifest.revisionId,
          proposal: proposal("Shop front, renamed", {
            steps: [
              {
                confirmation: false,
                description: "Start at the public storefront.",
                firstActionId: "action-open",
                lastActionId: "action-open",
                name: "Visit storefront",
              },
            ],
          }),
        })
      );
      expect(second.manifest.agentFlowId).toBe(id);
      expect(second.manifest.basedOnRevisionId).toBe(first.manifest.revisionId);
      expect(second.heads.draftRevisionId).toBe(second.manifest.revisionId);
      expect(second.manifest.steps[0]?.name).toBe("Visit storefront");
      // Unchanged evidence is the same content-addressed file.
      expect(second.manifest.steps[0]?.evidence).toEqual(
        first.manifest.steps[0]?.evidence
      );

      // The earlier revision is immutable and still readable.
      const earlier = yield* catalog.get(id, first.manifest.revisionId);
      expect(earlier.manifest.title).toBe("Shop front");
      expect(earlier.heads.draftRevisionId).toBe(second.manifest.revisionId);

      const missing = yield* Effect.flip(
        catalog.saveDraft(
          saveInput("Unknown", "rev-missing", {
            agentFlowId: AgentFlowId.make("flow-unknown"),
            basedOnRevisionId: AgentFlowRevisionId.make("rev-unknown"),
          })
        )
      );
      expect(missing.code).toBe("agent_flow_not_found");
    })
  )
);

it.effect("searches titles, descriptions, tags, and Step descriptions", () =>
  withCatalog((catalog, root) =>
    Effect.gen(function* searchDrafts() {
      yield* catalog.saveDraft(saveInput("Shop front", "s-1"));
      yield* catalog.saveDraft(
        saveInput("Pharmacy refill", "s-2", {
          proposal: proposal("Pharmacy refill", {
            description: "Reorder a prescription.",
            domainScope: { hosts: ["*.pharmacy.example"] },
            steps: [
              {
                confirmation: true,
                description: "Submit the refill request for the medicine.",
                firstActionId: "action-open",
                lastActionId: "action-open",
                name: "Request refill",
              },
            ],
            tags: ["pharmacy", "checkout"],
          }),
          slices: [slice("Request refill", "https://app.pharmacy.example/")],
        })
      );

      const all = yield* catalog.search({});
      expect(all.catalogRoot).toBe(root);
      expect(all.hits.map(({ title }) => title)).toEqual([
        "Pharmacy refill",
        "Shop front",
      ]);
      expect(all.hits.every(({ status }) => status === "draft")).toBe(true);

      const byTitle = yield* catalog.search({ query: "shop" });
      expect(byTitle.hits.map(({ title }) => title)).toEqual(["Shop front"]);
      expect(byTitle.hits[0]?.matchedFields).toEqual(
        expect.arrayContaining(["title", "tags", "steps"])
      );

      const byStep = yield* catalog.search({ query: "medicine" });
      expect(byStep.hits.map(({ title }) => title)).toEqual([
        "Pharmacy refill",
      ]);
      expect(byStep.hits[0]?.matchedFields).toEqual(["steps"]);

      // Every token must match: a query straddling two Agent Flows hits none.
      const straddling = yield* catalog.search({ query: "shop medicine" });
      expect(straddling.hits).toEqual([]);

      const prefix = yield* catalog.search({ query: "prescr" });
      expect(prefix.hits.map(({ title }) => title)).toEqual([
        "Pharmacy refill",
      ]);

      const byTag = yield* catalog.search({ tag: "checkout" });
      expect(byTag.hits.map(({ title }) => title)).toEqual(["Pharmacy refill"]);

      const byHost = yield* catalog.search({ host: "app.pharmacy.example" });
      expect(byHost.hits.map(({ title }) => title)).toEqual([
        "Pharmacy refill",
      ]);

      // No revision is approved yet, so approved coverage is empty rather
      // than a draft dressed up as approved.
      const approved = yield* catalog.search({ status: "approved" });
      expect(approved.hits).toEqual([]);
      const drafts = yield* catalog.search({ limit: 1, status: "draft" });
      expect(drafts.hits).toHaveLength(1);
    })
  )
);

it.effect("skips packages that no longer decode and reports the root", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* tolerateCorruptPackage() {
      const saved = yield* catalog.saveDraft(saveInput("Shop front", "c-1"));
      yield* catalog.saveDraft(saveInput("Second", "c-2"));
      yield* fileSystem.writeFileString(
        path.join(saved.path, "manifest.json"),
        "{ not json"
      );

      const hits = yield* catalog.search({});
      expect(hits.hits.map(({ title }) => title)).toEqual(["Second"]);
      const broken = yield* Effect.flip(
        catalog.get(saved.manifest.agentFlowId)
      );
      expect(broken.code).toBe("agent_catalog_invalid");
      expect(broken.message).toContain(root);
    })
  )
);

it.effect("selects an explicit absolute Catalog Root", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* selectRoot() {
      const relative = yield* Effect.flip(catalog.select("relative/catalog"));
      expect(relative.code).toBe("agent_catalog_invalid");

      const file = path.join(root, "not-a-directory");
      yield* fileSystem.writeFileString(file, "");
      const notDirectory = yield* Effect.flip(catalog.select(file));
      expect(notDirectory.code).toBe("agent_catalog_invalid");

      const other = path.join(root, "other");
      const selected = yield* catalog.select(other);
      expect(selected).toEqual({ agentFlowCount: 0, root: other });
      expect(yield* catalog.select(other, "select-root")).toEqual(selected);
      const selectConflict = yield* Effect.flip(
        catalog.select(path.join(root, "another"), "select-root")
      );
      expect(selectConflict.code).toBe("agent_flow_conflict");
      const saved = yield* catalog.saveDraft(saveInput("Shop front", "sel-1"));
      expect(saved.catalogRoot).toBe(other);
      expect((yield* catalog.info()).agentFlowCount).toBe(1);
    })
  )
);

it.effect(
  "keeps archived heads out of normal search and labels them when requested",
  () =>
    withCatalog((catalog, root, fileSystem) =>
      Effect.gen(function* searchArchived() {
        const saved = yield* catalog.saveDraft(
          saveInput("Retired shop", "archive-1")
        );
        const headsPath = path.join(
          root,
          AGENT_FLOWS_DIRECTORY,
          saved.manifest.agentFlowId,
          "agent-flow.json"
        );
        const heads = JSON.parse(
          yield* fileSystem.readFileString(headsPath)
        ) as Record<string, unknown>;
        yield* fileSystem.writeFileString(
          headsPath,
          JSON.stringify({ ...heads, archived: true })
        );

        expect((yield* catalog.search({})).hits).toEqual([]);
        expect((yield* catalog.search({ archived: true })).hits).toMatchObject([
          { archived: true, title: "Retired shop" },
        ]);
      })
    )
);

it.effect("recovers dead catalog locks but preserves foreign locks", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* recoverCatalogLock() {
      const lockPath = path.join(root, AGENT_FLOWS_DIRECTORY, ".catalog.lock");
      yield* fileSystem.makeDirectory(path.dirname(lockPath), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(lockPath, "999999999\n");
      const saved = yield* catalog.saveDraft(saveInput("Recovered", "lock-1"));
      expect(saved.manifest.title).toBe("Recovered");
      expect(yield* fileSystem.exists(lockPath)).toBe(false);

      yield* fileSystem.writeFileString(lockPath, "foreign lock\n");
      const refused = yield* Effect.flip(
        catalog.saveDraft(saveInput("Blocked", "lock-2"))
      );
      expect(refused.code).toBe("agent_flow_conflict");
      expect(yield* fileSystem.readFileString(lockPath)).toBe("foreign lock\n");
    })
  )
);

it("hashes evidence by content, not by key order", () => {
  const first = slice("Open the shop", "https://shop.example.com/");
  const reordered = Object.fromEntries(
    Object.entries(first).toReversed()
  ) as unknown as EvidenceSlice;
  expect(Object.keys(reordered)).not.toEqual(Object.keys(first));
  expect(evidenceHash(reordered)).toBe(evidenceHash(first));
  expect(canonicalJson({ a: [{ c: undefined, d: 2 }], b: 1 })).toBe(
    '{"a":[{"d":2}],"b":1}'
  );
  expect(Schema.is(AgentFlowId)("flow-abc")).toBe(true);
});

it("defaults the Catalog Root to the workspace's .contingency directory", () => {
  const previous = process.env.CONTINGENCY_CATALOG_ROOT;
  delete process.env.CONTINGENCY_CATALOG_ROOT;
  expect(defaultCatalogRoot("/work/site")).toBe("/work/site/.contingency");
  process.env.CONTINGENCY_CATALOG_ROOT = "/elsewhere/catalog";
  expect(defaultCatalogRoot("/work/site")).toBe("/elsewhere/catalog");
  if (previous === undefined) {
    delete process.env.CONTINGENCY_CATALOG_ROOT;
  } else {
    process.env.CONTINGENCY_CATALOG_ROOT = previous;
  }
});
