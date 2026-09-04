import { createHash } from "node:crypto";
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
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";

import {
  AGENT_FLOWS_DIRECTORY,
  AgentFlowCatalog,
  CATALOG_CONFIG_FILE,
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

const operationFile = (root: string, operationId: string): string =>
  path.join(
    root,
    AGENT_FLOWS_DIRECTORY,
    ".operations",
    `sha256-${createHash("sha256").update(operationId).digest("hex")}.json`
  );

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

it.effect("recovers a pending save before its head move after restart", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* pendingBeforeHeadMove() {
      const input = saveInput("Pending before", "save-pending-before");
      const saved = yield* catalog.saveDraft(input);
      const headsFile = path.join(saved.path, "..", "..", "agent-flow.json");
      const operationPath = operationFile(root, "save-pending-before");
      const record = JSON.parse(
        yield* fileSystem.readFileString(operationPath)
      ) as Record<string, unknown>;
      yield* fileSystem.writeFileString(
        operationPath,
        JSON.stringify({ ...record, status: "pending" })
      );
      yield* fileSystem.remove(headsFile);
      yield* fileSystem.remove(saved.path, { recursive: true });
      const [step] = saved.manifest.steps;
      if (step !== undefined) {
        yield* fileSystem.remove(
          path.join(
            root,
            AGENT_FLOWS_DIRECTORY,
            saved.manifest.agentFlowId,
            step.evidence.path
          )
        );
      }

      yield* Effect.scoped(
        Effect.gen(function* restart() {
          const context = yield* Layer.build(
            makeAgentFlowCatalogLayer({ root }).pipe(
              Layer.provide(NodeServices.layer)
            )
          );
          const restarted = Context.get(context, AgentFlowCatalog);
          expect(yield* restarted.saveDraft(input)).toEqual(saved);
          expect(
            JSON.parse(yield* fileSystem.readFileString(operationPath))
          ).toMatchObject({ status: "completed" });
          expect(
            yield* fileSystem.exists(path.join(saved.path, "manifest.json"))
          ).toBe(true);
          expect(yield* catalog.info()).toEqual({
            agentFlowCount: 1,
            root,
          });
        })
      );
    })
  )
);

it.effect("completes a pending save after its head move", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* pendingAfterHeadMove() {
      const input = saveInput("Pending after", "save-pending-after");
      const saved = yield* catalog.saveDraft(input);
      const operationPath = operationFile(root, "save-pending-after");
      const record = JSON.parse(
        yield* fileSystem.readFileString(operationPath)
      ) as Record<string, unknown>;
      yield* fileSystem.writeFileString(
        operationPath,
        JSON.stringify({ ...record, status: "pending" })
      );

      yield* Effect.scoped(
        Effect.gen(function* restart() {
          const context = yield* Layer.build(
            makeAgentFlowCatalogLayer({ root }).pipe(
              Layer.provide(NodeServices.layer)
            )
          );
          const restarted = Context.get(context, AgentFlowCatalog);
          expect(yield* restarted.saveDraft(input)).toEqual(saved);
          expect(
            JSON.parse(yield* fileSystem.readFileString(operationPath))
          ).toMatchObject({ status: "completed" });
        })
      );
    })
  )
);

it.effect("refuses a persisted operation with an invalid head transition", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* invalidPersistedTransition() {
      const input = saveInput("Invalid transition", "save-invalid-transition");
      yield* catalog.saveDraft(input);
      const operationPath = operationFile(root, "save-invalid-transition");
      const record = JSON.parse(
        yield* fileSystem.readFileString(operationPath)
      ) as {
        result: { heads: Record<string, unknown> };
      };
      yield* fileSystem.writeFileString(
        operationPath,
        JSON.stringify({
          ...record,
          result: {
            ...record.result,
            heads: { ...record.result.heads, archived: true },
          },
        })
      );

      yield* Effect.scoped(
        Effect.gen(function* restart() {
          const restartedContext = yield* Layer.build(
            makeAgentFlowCatalogLayer({ root }).pipe(
              Layer.provide(NodeServices.layer)
            )
          );
          const restarted = Context.get(restartedContext, AgentFlowCatalog);
          const refused = yield* Effect.flip(restarted.saveDraft(input));
          expect(refused.code).toBe("agent_catalog_invalid");
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
      const third = path.join(root, "third");
      expect(yield* catalog.select(third)).toEqual({
        agentFlowCount: 0,
        root: third,
      });
      expect(yield* catalog.select(other, "select-root")).toEqual(selected);
      expect((yield* catalog.info()).root).toBe(other);
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

it.effect("scopes save operation replay by Catalog Root", () =>
  withCatalog((catalog, root) =>
    Effect.gen(function* rootScopedOperationReplay() {
      const operationId = "same-operation-id";
      const first = yield* catalog.saveDraft(
        saveInput("First root", operationId)
      );
      const other = path.join(root, "other-root");
      yield* catalog.select(other);
      const second = yield* catalog.saveDraft(
        saveInput("Second root", operationId)
      );

      expect(first.catalogRoot).toBe(root);
      expect(second.catalogRoot).toBe(other);
      expect(second.manifest.title).toBe("Second root");
      expect((yield* catalog.info()).agentFlowCount).toBe(1);
    })
  )
);

it.effect("rejects flow and operation paths that escape through symlinks", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.scoped(
      Effect.gen(function* rejectSymlinkEscapes() {
        const outsideFlows = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "contingency-outside-flows-",
        });
        const flows = path.join(root, AGENT_FLOWS_DIRECTORY);
        yield* fileSystem.symlink(outsideFlows, flows);
        const refusedFlow = yield* Effect.flip(
          catalog.saveDraft(saveInput("Symlink flow", "symlink-flow"))
        );
        expect(refusedFlow.code).toBe("agent_catalog_invalid");
        expect(yield* fileSystem.readDirectory(outsideFlows)).toEqual([]);

        const validRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "contingency-symlink-operation-root-",
        });
        const context = yield* Layer.build(
          makeAgentFlowCatalogLayer({ root: validRoot }).pipe(
            Layer.provide(NodeServices.layer)
          )
        );
        const validCatalog = Context.get(context, AgentFlowCatalog);
        const input = saveInput("Safe operation", "symlink-operation");
        yield* validCatalog.saveDraft(input);
        const operations = path.join(
          validRoot,
          AGENT_FLOWS_DIRECTORY,
          ".operations"
        );
        const outsideOperations = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "contingency-outside-operations-",
        });
        const operationName = path.basename(
          operationFile(validRoot, "symlink-operation")
        );
        yield* fileSystem.writeFileString(
          path.join(outsideOperations, operationName),
          yield* fileSystem.readFileString(
            operationFile(validRoot, "symlink-operation")
          )
        );
        yield* fileSystem.remove(operations, { recursive: true });
        yield* fileSystem.symlink(outsideOperations, operations);
        const restartedContext = yield* Layer.build(
          makeAgentFlowCatalogLayer({ root: validRoot }).pipe(
            Layer.provide(NodeServices.layer)
          )
        );
        const restarted = Context.get(restartedContext, AgentFlowCatalog);
        const refusedOperation = yield* Effect.flip(restarted.saveDraft(input));
        expect(refusedOperation.code).toBe("agent_catalog_invalid");
      })
    )
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

it.effect("binds one verification authorization to one exact draft", () =>
  withCatalog((catalog) =>
    Effect.gen(function* authorizeOneExactDraft() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "verify-save")
      );
      const { agentFlowId } = saved.manifest;

      const stale = yield* Effect.flip(
        catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("verify-stale"),
          revisionId: AgentFlowRevisionId.make("rev-not-the-head"),
        })
      );
      expect(stale.code).toBe("agent_flow_conflict");

      const authorized = yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("verify-authorize"),
        revisionId: saved.manifest.revisionId,
      });
      expect(authorized.heads.verification?.status).toBe("authorized");
      expect(authorized.heads.verification?.revisionId).toBe(
        saved.manifest.revisionId
      );

      // A corrected draft is a different draft, so the gesture does not travel.
      const corrected = yield* catalog.saveDraft(
        saveInput("Shop front", "verify-correct", {
          agentFlowId,
          basedOnRevisionId: saved.manifest.revisionId,
          proposal: proposal("Shop front", {
            steps: [
              {
                confirmation: true,
                description: "Open the shop front page and check it renders.",
                firstActionId: "action-open",
                lastActionId: "action-open",
                name: "Open the shop front",
              },
            ],
          }),
        })
      );
      expect(corrected.heads.verification).toBeNull();

      const spent = yield* Effect.flip(
        catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("verify-start-stale"),
          revisionId: corrected.manifest.revisionId,
          sessionId: AgentSessionId.make("agent-verification"),
        })
      );
      expect(spent.code).toBe("agent_flow_conflict");
    })
  )
);

it.effect("spends one authorization on one Verification Run", () =>
  withCatalog((catalog) =>
    Effect.gen(function* spendAuthorizationOnce() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "spend-save")
      );
      const { agentFlowId } = saved.manifest;
      const { revisionId } = saved.manifest;
      yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("spend-authorize"),
        revisionId,
      });
      const running = yield* catalog.startVerification({
        agentFlowId,
        operationId: OperationId.make("spend-start"),
        revisionId,
        sessionId: AgentSessionId.make("agent-verification"),
      });
      expect(running.heads.verification?.status).toBe("running");
      expect(running.heads.verification?.sessionId).toBe("agent-verification");

      const second = yield* Effect.flip(
        catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("spend-start-again"),
          revisionId,
          sessionId: AgentSessionId.make("agent-verification-2"),
        })
      );
      expect(second.code).toBe("agent_flow_conflict");
    })
  )
);

it.effect(
  "leaves the approved revision untouched when verification fails",
  () =>
    withCatalog((catalog) =>
      Effect.gen(function* keepApprovedOnFailure() {
        const first = yield* catalog.saveDraft(
          saveInput("Shop front", "fail-save")
        );
        const { agentFlowId } = first.manifest;
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("fail-authorize-1"),
          revisionId: first.manifest.revisionId,
        });
        yield* catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("fail-start-1"),
          revisionId: first.manifest.revisionId,
          sessionId: AgentSessionId.make("agent-verify-1"),
        });
        yield* catalog.completeVerification({
          agentFlowId,
          operationId: OperationId.make("fail-complete-1"),
          outcome: "passed",
          revisionId: first.manifest.revisionId,
          summary: "Every Agent Step worked.",
        });
        const approved = yield* catalog.approve({
          agentFlowId,
          operationId: OperationId.make("fail-approve-1"),
          revisionId: first.manifest.revisionId,
        });
        expect(approved.manifest.status).toBe("approved");
        expect(approved.heads.approvedRevisionId).toBe(
          first.manifest.revisionId
        );
        expect(approved.heads.draftRevisionId).toBeNull();

        const second = yield* catalog.saveDraft(
          saveInput("Shop front", "fail-save-2", {
            agentFlowId,
            basedOnRevisionId: first.manifest.revisionId,
          })
        );
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("fail-authorize-2"),
          revisionId: second.manifest.revisionId,
        });
        yield* catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("fail-start-2"),
          revisionId: second.manifest.revisionId,
          sessionId: AgentSessionId.make("agent-verify-2"),
        });
        const failed = yield* catalog.completeVerification({
          agentFlowId,
          operationId: OperationId.make("fail-complete-2"),
          outcome: "failed",
          revisionId: second.manifest.revisionId,
          summary: "The basket never showed the added item.",
        });
        expect(failed.heads.verification?.status).toBe("failed");
        expect(failed.heads.approvedRevisionId).toBe(first.manifest.revisionId);

        const refused = yield* Effect.flip(
          catalog.approve({
            agentFlowId,
            operationId: OperationId.make("fail-approve-2"),
            revisionId: second.manifest.revisionId,
          })
        );
        expect(refused.code).toBe("agent_flow_conflict");
        const stillApproved = yield* catalog.get(
          agentFlowId,
          first.manifest.revisionId
        );
        expect(stillApproved.manifest.status).toBe("approved");
      })
    )
);

it.effect("refuses to approve a draft that never passed verification", () =>
  withCatalog((catalog) =>
    Effect.gen(function* refuseUnverifiedApproval() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "unverified-save")
      );
      const refused = yield* Effect.flip(
        catalog.approve({
          agentFlowId: saved.manifest.agentFlowId,
          operationId: OperationId.make("unverified-approve"),
          revisionId: saved.manifest.revisionId,
        })
      );
      expect(refused.code).toBe("agent_flow_conflict");
      const read = yield* catalog.get(saved.manifest.agentFlowId);
      expect(read.manifest.status).toBe("draft");
    })
  )
);

it.effect("replays authorization and approval by operation id", () =>
  withCatalog((catalog) =>
    Effect.gen(function* replayHeadMutations() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "replay-save")
      );
      const { agentFlowId } = saved.manifest;
      const { revisionId } = saved.manifest;
      const first = yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("replay-authorize"),
        revisionId,
      });
      const again = yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("replay-authorize"),
        revisionId,
      });
      // A retry answers with the original authorization rather than minting a
      // second one, so one gesture still funds exactly one Run.
      expect(again.heads.verification?.authorizationId).toBe(
        first.heads.verification?.authorizationId
      );

      const reused = yield* Effect.flip(
        catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("replay-authorize"),
          revisionId: AgentFlowRevisionId.make("rev-other"),
        })
      );
      expect(reused.code).toBe("agent_flow_conflict");

      yield* catalog.startVerification({
        agentFlowId,
        operationId: OperationId.make("replay-start"),
        revisionId,
        sessionId: AgentSessionId.make("agent-replay"),
      });
      yield* catalog.completeVerification({
        agentFlowId,
        operationId: OperationId.make("replay-complete"),
        outcome: "passed",
        revisionId,
        summary: "It worked.",
      });
      const approved = yield* catalog.approve({
        agentFlowId,
        operationId: OperationId.make("replay-approve"),
        revisionId,
      });
      const approvedAgain = yield* catalog.approve({
        agentFlowId,
        operationId: OperationId.make("replay-approve"),
        revisionId,
      });
      expect(approvedAgain).toEqual(approved);
      expect(approvedAgain.heads.approvedRevisionId).toBe(revisionId);
    })
  )
);

it.effect("reads the Evidence Slices behind a revision in Step order", () =>
  withCatalog((catalog) =>
    Effect.gen(function* readRevisionEvidence() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "evidence-save")
      );
      const slices = yield* catalog.evidence(saved.manifest.agentFlowId);
      expect(slices).toEqual([
        slice("Open the shop", "https://shop.example.com/"),
      ]);
    })
  )
);

it.effect("reads a Catalog Root written before drafts were verified", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* readOlderCatalogRoot() {
      const saved = yield* catalog.saveDraft(saveInput("Shop front", "old-1"));
      const flowDirectory = path.join(
        root,
        AGENT_FLOWS_DIRECTORY,
        saved.manifest.agentFlowId
      );

      // What an earlier Contingency wrote: a v1 manifest whose Agent Steps had
      // no demonstrated span, plus heads with no verification key.
      const heads = JSON.parse(
        yield* fileSystem.readFileString(
          path.join(flowDirectory, "agent-flow.json")
        )
      ) as Record<string, unknown>;
      delete heads.verification;
      yield* fileSystem.writeFileString(
        path.join(flowDirectory, "agent-flow.json"),
        JSON.stringify(heads)
      );

      const manifestFile = path.join(saved.path, "manifest.json");
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(manifestFile)
      ) as { schemaVersion: number; steps: Record<string, unknown>[] };
      manifest.schemaVersion = 1;
      for (const step of manifest.steps) {
        delete step.firstActionId;
        delete step.lastActionId;
      }
      yield* fileSystem.writeFileString(manifestFile, JSON.stringify(manifest));

      const read = yield* catalog.get(saved.manifest.agentFlowId);
      expect(read.heads.verification).toBeNull();
      // The Evidence Slice the Step names was cut from exactly its span, so
      // its first and last captured actions are the span's boundaries.
      const [recovered] = read.manifest.steps;
      const [captured] = slice(
        "Open the shop",
        "https://shop.example.com/"
      ).actions;
      expect(recovered?.firstActionId).toBe(captured?.id);
      expect(recovered?.lastActionId).toBe(captured?.id);
      expect(read.manifest.schemaVersion).toBe(2);
      expect(read.manifest.agentFlowId).toBe(saved.manifest.agentFlowId);
      expect(read.manifest.revisionId).toBe(saved.manifest.revisionId);
      // Reading migrates in memory. The v1 package remains untouched on disk.
      expect(
        (
          JSON.parse(yield* fileSystem.readFileString(manifestFile)) as Record<
            string,
            unknown
          >
        ).schemaVersion
      ).toBe(1);
      yield* catalog.setArchived({
        agentFlowId: saved.manifest.agentFlowId,
        archived: true,
        expectedHeads: read.heads,
        operationId: OperationId.make("archive-migrated-v1"),
      });
      expect(
        (
          JSON.parse(yield* fileSystem.readFileString(manifestFile)) as Record<
            string,
            unknown
          >
        ).schemaVersion
      ).toBe(1);
    })
  )
);

it.effect(
  "revises an approved head without replacing the usable approved revision",
  () =>
    withCatalog((catalog) =>
      Effect.gen(function* reviseApprovedFlow() {
        const first = yield* catalog.saveDraft(
          saveInput("Shop front", "approved-save")
        );
        const { agentFlowId, revisionId } = first.manifest;
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("approved-authorize"),
          revisionId,
        });
        yield* catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("approved-start"),
          revisionId,
          sessionId: AgentSessionId.make("agent-approved"),
        });
        yield* catalog.completeVerification({
          agentFlowId,
          operationId: OperationId.make("approved-complete"),
          outcome: "passed",
          revisionId,
          summary: "The approved revision worked.",
        });
        yield* catalog.approve({
          agentFlowId,
          operationId: OperationId.make("approved-approve"),
          revisionId,
        });

        const edit = (operationId: string, title: string) =>
          catalog.saveDraft(
            saveInput(title, operationId, {
              agentFlowId,
              basedOnRevisionId: revisionId,
              proposal: proposal(title),
            })
          );
        const [left, right] = yield* Effect.all(
          [
            Effect.result(edit("approved-edit-left", "Left edit")),
            Effect.result(edit("approved-edit-right", "Right edit")),
          ],
          { concurrency: "unbounded" }
        );
        const successes = [left, right].filter(Result.isSuccess);
        const failures = [left, right].filter(Result.isFailure);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.failure.code).toBe("agent_flow_conflict");

        const current = yield* catalog.get(agentFlowId);
        expect(current.heads.approvedRevisionId).toBe(revisionId);
        expect(current.heads.draftRevisionId).toBe(
          successes[0]?.success.manifest.revisionId
        );
        const approvedSearch = yield* catalog.search({ status: "approved" });
        expect(approvedSearch.hits.map((hit) => hit.revisionId)).toEqual([
          revisionId,
        ]);
        expect(
          (yield* catalog.get(agentFlowId, revisionId)).manifest.status
        ).toBe("approved");
      })
    )
);

it.effect("archives and restores only from the heads the caller read", () =>
  withCatalog((catalog) =>
    Effect.gen(function* archiveAndRestore() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "archive-save")
      );
      const archived = yield* catalog.setArchived({
        agentFlowId: saved.manifest.agentFlowId,
        archived: true,
        expectedHeads: saved.heads,
        operationId: OperationId.make("archive"),
      });
      expect(archived.heads.archived).toBe(true);
      expect((yield* catalog.search({})).hits).toEqual([]);
      expect((yield* catalog.search({ archived: true })).hits).toHaveLength(1);
      expect(
        (yield* catalog.get(saved.manifest.agentFlowId)).heads.archived
      ).toBe(true);

      const stale = yield* Effect.flip(
        catalog.setArchived({
          agentFlowId: saved.manifest.agentFlowId,
          archived: false,
          expectedHeads: saved.heads,
          operationId: OperationId.make("restore-stale"),
        })
      );
      expect(stale.code).toBe("agent_flow_conflict");

      const restored = yield* catalog.setArchived({
        agentFlowId: saved.manifest.agentFlowId,
        archived: false,
        expectedHeads: archived.heads,
        operationId: OperationId.make("restore"),
      });
      expect(restored.heads.archived).toBe(false);
      expect((yield* catalog.search({})).hits).toHaveLength(1);
    })
  )
);

it.effect("permanently deletes only after exact direct confirmation", () =>
  withCatalog((catalog) =>
    Effect.gen(function* confirmPermanentDeletion() {
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "delete-save")
      );
      const refused = yield* Effect.flip(
        catalog.deletePermanently({
          agentFlowId: saved.manifest.agentFlowId,
          confirmation: "archive-instead",
          expectedHeads: saved.heads,
          operationId: OperationId.make("delete-refused"),
        })
      );
      expect(refused.code).toBe("agent_catalog_invalid");
      expect(yield* catalog.get(saved.manifest.agentFlowId)).toEqual(saved);

      const deleted = yield* catalog.deletePermanently({
        agentFlowId: saved.manifest.agentFlowId,
        confirmation: "permanently-delete",
        expectedHeads: saved.heads,
        operationId: OperationId.make("delete-confirmed"),
      });
      expect(deleted).toEqual({
        agentFlowId: saved.manifest.agentFlowId,
        deleted: true,
      });
      expect(
        yield* catalog.deletePermanently({
          agentFlowId: saved.manifest.agentFlowId,
          confirmation: "permanently-delete",
          expectedHeads: saved.heads,
          operationId: OperationId.make("delete-confirmed"),
        })
      ).toEqual(deleted);
      const missing = yield* Effect.flip(
        catalog.get(saved.manifest.agentFlowId)
      );
      expect(missing.code).toBe("agent_flow_not_found");
    })
  )
);

it.effect(
  "deletes sensitive Teaching artifacts on approval and keeps catalog evidence",
  () =>
    withCatalog((catalog, root, fileSystem) =>
      Effect.gen(function* applyDefaultApprovalRetention() {
        const artifactDirectory = path.join(root, "teaching-artifacts");
        yield* fileSystem.makeDirectory(artifactDirectory);
        const traceFile = path.join(artifactDirectory, "teaching.trace.zip");
        const videoFile = path.join(artifactDirectory, "teaching.webm");
        const retentionFile = path.join(
          artifactDirectory,
          "teaching.artifacts.json"
        );
        yield* fileSystem.writeFileString(traceFile, "trace");
        yield* fileSystem.writeFileString(videoFile, "video");
        yield* fileSystem.writeFileString(retentionFile, "{}");
        const saved = yield* catalog.saveDraft(
          saveInput("Shop front", "retention-save", {
            sourceArtifacts: {
              retentionFile,
              traceFile,
              videoFile,
            },
          })
        );
        const { agentFlowId, revisionId } = saved.manifest;
        yield* catalog.authorizeVerification({
          agentFlowId,
          operationId: OperationId.make("retention-authorize"),
          revisionId,
        });
        yield* catalog.startVerification({
          agentFlowId,
          operationId: OperationId.make("retention-start"),
          revisionId,
          sessionId: AgentSessionId.make("agent-retention"),
        });
        yield* catalog.completeVerification({
          agentFlowId,
          operationId: OperationId.make("retention-complete"),
          outcome: "passed",
          revisionId,
          summary: "It worked.",
        });
        const approved = yield* catalog.approve({
          agentFlowId,
          operationId: OperationId.make("retention-approve"),
          revisionId,
        });

        expect(yield* fileSystem.exists(traceFile)).toBe(false);
        expect(yield* fileSystem.exists(videoFile)).toBe(false);
        expect(
          JSON.parse(yield* fileSystem.readFileString(retentionFile))
        ).toMatchObject({
          approvedAt: at,
          retention: "delete-on-approval",
        });
        expect(yield* fileSystem.exists(approved.path)).toBe(true);
        expect(yield* catalog.evidence(agentFlowId, revisionId)).toHaveLength(
          1
        );
        expect(approved.heads.verification?.status).toBe("passed");
      })
    )
);

it.effect("does not report a committed approval as failed", () =>
  withCatalog((catalog, root, fileSystem) =>
    Effect.gen(function* keepApprovalResultAtomic() {
      const artifactDirectory = path.join(root, "approval-failure-artifacts");
      yield* fileSystem.makeDirectory(artifactDirectory);
      const traceFile = path.join(artifactDirectory, "teaching.trace.zip");
      const retentionFile = path.join(
        artifactDirectory,
        "teaching.artifacts.json"
      );
      yield* fileSystem.writeFileString(traceFile, "trace");
      yield* fileSystem.writeFileString(retentionFile, "{}");
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "approval-failure-save", {
          sourceArtifacts: { retentionFile, traceFile },
        })
      );
      const { agentFlowId, revisionId } = saved.manifest;
      yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("approval-failure-authorize"),
        revisionId,
      });
      yield* catalog.startVerification({
        agentFlowId,
        operationId: OperationId.make("approval-failure-start"),
        revisionId,
        sessionId: AgentSessionId.make("agent-approval-failure"),
      });
      yield* catalog.completeVerification({
        agentFlowId,
        operationId: OperationId.make("approval-failure-complete"),
        outcome: "passed",
        revisionId,
        summary: "It worked.",
      });
      yield* fileSystem.writeFileString(
        path.join(root, CATALOG_CONFIG_FILE),
        "not valid JSON"
      );

      const approved = yield* catalog.approve({
        agentFlowId,
        operationId: OperationId.make("approval-failure-approve"),
        revisionId,
      });

      expect(approved.heads.approvedRevisionId).toBe(revisionId);
      expect(approved.heads.draftRevisionId).toBeNull();
      expect(yield* fileSystem.exists(traceFile)).toBe(false);
    })
  )
);

it.effect("reads an approval retention duration from each Catalog Root", () =>
  withCatalog((_catalog, root, fileSystem) =>
    Effect.gen(function* retainByCatalogPolicy() {
      yield* fileSystem.writeFileString(
        path.join(root, CATALOG_CONFIG_FILE),
        JSON.stringify({
          approvalArtifactRetention: { days: 30, mode: "retain-for-days" },
          schemaVersion: 1,
        })
      );
      const context = yield* Layer.build(
        makeAgentFlowCatalogLayer({ now: () => new Date(at), root }).pipe(
          Layer.provide(NodeServices.layer)
        )
      ).pipe(Effect.scoped);
      const catalog = Context.get(context, AgentFlowCatalog);
      const artifactDirectory = path.join(root, "retained-artifacts");
      yield* fileSystem.makeDirectory(artifactDirectory);
      const traceFile = path.join(artifactDirectory, "teaching.trace.zip");
      const videoFile = path.join(artifactDirectory, "teaching.webm");
      const retentionFile = path.join(
        artifactDirectory,
        "teaching.artifacts.json"
      );
      yield* fileSystem.writeFileString(traceFile, "trace");
      yield* fileSystem.writeFileString(videoFile, "video");
      yield* fileSystem.writeFileString(retentionFile, "{}");
      const saved = yield* catalog.saveDraft(
        saveInput("Shop front", "retained-save", {
          sourceArtifacts: { retentionFile, traceFile, videoFile },
        })
      );
      const { agentFlowId, revisionId } = saved.manifest;
      yield* catalog.authorizeVerification({
        agentFlowId,
        operationId: OperationId.make("retained-authorize"),
        revisionId,
      });
      yield* catalog.startVerification({
        agentFlowId,
        operationId: OperationId.make("retained-start"),
        revisionId,
        sessionId: AgentSessionId.make("agent-retained"),
      });
      yield* catalog.completeVerification({
        agentFlowId,
        operationId: OperationId.make("retained-complete"),
        outcome: "passed",
        revisionId,
        summary: "It worked.",
      });
      yield* catalog.approve({
        agentFlowId,
        operationId: OperationId.make("retained-approve"),
        revisionId,
      });

      expect(yield* fileSystem.exists(traceFile)).toBe(true);
      expect(yield* fileSystem.exists(videoFile)).toBe(true);
      expect(
        JSON.parse(yield* fileSystem.readFileString(retentionFile))
      ).toMatchObject({
        deleteAfter: "2026-10-01T00:00:00.000Z",
        retention: "retain-for-days",
      });

      yield* Layer.build(
        makeAgentFlowCatalogLayer({
          now: () => new Date("2026-10-02T00:00:00.000Z"),
          root,
        }).pipe(Layer.provide(NodeServices.layer))
      ).pipe(Effect.scoped);

      expect(yield* fileSystem.exists(traceFile)).toBe(false);
      expect(yield* fileSystem.exists(videoFile)).toBe(false);
      expect(
        JSON.parse(yield* fileSystem.readFileString(retentionFile))
      ).toMatchObject({
        deleteAfter: "2026-10-01T00:00:00.000Z",
        expiredAt: "2026-10-02T00:00:00.000Z",
        retention: "expired",
      });
    })
  )
);
