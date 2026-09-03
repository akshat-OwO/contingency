import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentFlowHeads,
  AgentFlowId,
  AgentFlowManifest,
  AgentFlowRevision,
  AgentFlowRevisionId,
  EvidenceHash,
  EvidenceSlice,
  OperationId,
} from "@contingency/protocol";
import type {
  AgentCatalogInfo,
  AgentFlowCompiler,
  AgentFlowDraftProposal,
  AgentFlowSearch,
  AgentFlowSearchHit,
  AgentFlowSearchResult,
  AgentSessionId,
  DraftEmulation,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

import { domainScopeCovers } from "./agent-flow-compiler.ts";

/** The directory under a Catalog Root that holds Agent Flow packages. */
export const AGENT_FLOWS_DIRECTORY = "agent-flows";
const HEADS_FILE = "agent-flow.json";
const REVISIONS_DIRECTORY = "revisions";
const EVIDENCE_DIRECTORY = "evidence";
const MANIFEST_FILE = "manifest.json";
const OPERATIONS_DIRECTORY = ".operations";
const DEFAULT_SEARCH_LIMIT = 20;

/** The workspace's `.contingency` directory unless the environment names one. */
export const defaultCatalogRoot = (cwd: string = process.cwd()): string => {
  const configured = process.env.CONTINGENCY_CATALOG_ROOT?.trim();
  return configured ? path.resolve(configured) : path.join(cwd, ".contingency");
};

interface AgentFlowCatalogDomainError {
  readonly _tag: "AgentFlowCatalogError";
  readonly code:
    | "agent_catalog_invalid"
    | "agent_catalog_io"
    | "agent_flow_conflict"
    | "agent_flow_not_found";
  readonly message: string;
}
export type AgentFlowCatalogError = AgentFlowCatalogDomainError;

const catalogError = (
  code: AgentFlowCatalogDomainError["code"],
  message: string
): AgentFlowCatalogDomainError => ({
  _tag: "AgentFlowCatalogError",
  code,
  message,
});

const ioError = (context: string) => (cause: PlatformError) =>
  catalogError("agent_catalog_io", `${context}: ${cause.message}`);

/** Only the exact format written by Contingency is eligible for recovery. */
const lockOwnerPid = (contents: string): number | undefined => {
  const match = /^(?<pid>[1-9][0-9]*)\n$/u.exec(contents);
  if (match === null) {
    return undefined;
  }
  const pid = Number(match.groups?.pid);
  return Number.isSafeInteger(pid) ? pid : undefined;
};

/** EPERM means the owner is alive; only ESRCH is a stale owner. */
const processIsStale = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return code === "ESRCH";
  }
};

const isWithinCatalogRoot = (catalogRoot: string, target: string): boolean => {
  const relative = path.relative(
    path.resolve(catalogRoot),
    path.resolve(target)
  );
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

export interface SaveDraftInput {
  /** Revise this Agent Flow; a new identity is minted when omitted. */
  readonly agentFlowId?: AgentFlowId | undefined;
  readonly basedOnRevisionId: AgentFlowRevisionId | null;
  readonly compiler: AgentFlowCompiler;
  readonly emulation: DraftEmulation;
  readonly operationId?: OperationId | string | undefined;
  readonly proposal: AgentFlowDraftProposal;
  readonly slices: readonly EvidenceSlice[];
  readonly sourceSessionId: AgentSessionId;
}

export interface AgentFlowCatalogService {
  /** Read one revision: the named one, or the current draft head. */
  readonly get: (
    agentFlowId: AgentFlowId,
    revisionId?: AgentFlowRevisionId
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  readonly info: () => Effect.Effect<AgentCatalogInfo, AgentFlowCatalogError>;
  /**
   * Persist one validated draft revision as a directory package. The write
   * names the draft head it started from and is refused when that head moved
   * ([ADR 0028](../../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
   */
  readonly saveDraft: (
    input: SaveDraftInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /** Replay or recover a save before a Teaching session is available. */
  readonly replayDraftSave: (
    operationId: OperationId | string,
    requestInput: string
  ) => Effect.Effect<AgentFlowRevision | null, AgentFlowCatalogError>;
  readonly search: (
    query: AgentFlowSearch
  ) => Effect.Effect<AgentFlowSearchResult, AgentFlowCatalogError>;
  /** Choose the Catalog Root explicitly. Never a user-global directory scan. */
  readonly select: (
    root: string,
    operationId?: OperationId | string
  ) => Effect.Effect<AgentCatalogInfo, AgentFlowCatalogError>;
}

export const AgentFlowCatalog = Context.Service<AgentFlowCatalogService>(
  "@contingency/AgentFlowCatalog"
);

export interface AgentFlowCatalogOptions {
  readonly now?: () => Date;
  /** Notify process-owned companions when this catalog changes roots. */
  readonly onSelect?: (root: string) => void;
  readonly root: string;
}

const AgentFlowOperationRecord = Schema.Struct({
  expectedHeads: Schema.NullOr(AgentFlowHeads),
  input: Schema.String,
  operationId: OperationId,
  result: AgentFlowRevision,
  schemaVersion: Schema.Literal(1),
  slices: Schema.Array(EvidenceSlice),
  status: Schema.Literals(["pending", "completed"]),
});
type AgentFlowOperationRecord = typeof AgentFlowOperationRecord.Type;

/**
 * JSON with keys in a stable order, so one Evidence Slice always hashes to
 * one address regardless of how its object was assembled.
 */
const compareKeys = (
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown]
): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const normalizeJson = (input: unknown): unknown => {
  if (Array.isArray(input)) {
    return input.map(normalizeJson);
  }
  if (typeof input === "object" && input !== null) {
    const entries = Object.entries(input)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(compareKeys);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, normalizeJson(entryValue)])
    );
  }
  return input;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeJson(value));

/** The MCP-visible portion of a draft save request, stable across restarts. */
export const normalizedDraftSaveInput = (input: {
  readonly agentFlowId?: AgentFlowId | undefined;
  readonly basedOnRevisionId: AgentFlowRevisionId | null;
  readonly proposal: AgentFlowDraftProposal;
  readonly sourceSessionId: AgentSessionId;
}): string =>
  canonicalJson({
    agentFlowId: input.agentFlowId ?? null,
    basedOnRevisionId: input.basedOnRevisionId,
    proposal: input.proposal,
    sessionId: input.sourceSessionId,
  });

const encodeSlice = Schema.encodeSync(EvidenceSlice);
const encodeManifest = Schema.encodeSync(AgentFlowManifest);
const encodeHeads = Schema.encodeSync(AgentFlowHeads);
const encodeOperation = Schema.encodeSync(AgentFlowOperationRecord);

const operationRecord = (
  status: AgentFlowOperationRecord["status"],
  operationId: string,
  input: string,
  expectedHeads: AgentFlowHeads | null,
  result: AgentFlowRevision,
  slices: readonly EvidenceSlice[]
): AgentFlowOperationRecord => ({
  expectedHeads,
  input,
  operationId: OperationId.make(operationId),
  result,
  schemaVersion: 1,
  slices,
  status,
});

export const evidenceHash = (slice: EvidenceSlice): EvidenceHash =>
  EvidenceHash.make(
    `sha256-${createHash("sha256")
      .update(canonicalJson(encodeSlice(slice)))
      .digest("hex")}`
  );

const sameHeads = (left: AgentFlowHeads, right: AgentFlowHeads): boolean =>
  canonicalJson(encodeHeads(left)) === canonicalJson(encodeHeads(right));

const matchesExpectedHeads = (
  expected: AgentFlowHeads | null,
  current: AgentFlowHeads | null
): boolean =>
  expected === null
    ? current === null
    : current !== null && sameHeads(current, expected);

const operationCacheKey = (catalogRoot: string, operationId: string): string =>
  `${catalogRoot}\u0000${operationId}`;

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);

interface SearchField {
  readonly name: string;
  readonly text: string;
  readonly weight: number;
}

const searchFields = (manifest: AgentFlowManifest): SearchField[] => [
  { name: "title", text: manifest.title, weight: 3 },
  { name: "tags", text: manifest.tags.join(" "), weight: 3 },
  { name: "description", text: manifest.description, weight: 2 },
  {
    name: "steps",
    text: manifest.steps
      .map((step) => `${step.name} ${step.description}`)
      .join(" "),
    weight: 1,
  },
];

/**
 * Local full-text matching: every query token must appear in at least one
 * searchable field, as a token prefix. The score sums field weights per
 * matched token so a title hit outranks a Step description hit.
 */
const scoreManifest = (
  manifest: AgentFlowManifest,
  query: string | undefined
): { readonly matchedFields: string[]; readonly score: number } | undefined => {
  const queryTokens = tokens(query ?? "");
  if (queryTokens.length === 0) {
    return { matchedFields: [], score: 0 };
  }
  const fields = searchFields(manifest).map((field) => ({
    ...field,
    tokens: tokens(field.text),
  }));
  const matched = new Set<string>();
  let score = 0;
  for (const token of queryTokens) {
    let found = false;
    for (const field of fields) {
      if (field.tokens.some((candidate) => candidate.startsWith(token))) {
        found = true;
        matched.add(field.name);
        score += field.weight;
      }
    }
    if (!found) {
      return undefined;
    }
  }
  return { matchedFields: [...matched], score };
};

const compareHits = (left: AgentFlowSearchHit, right: AgentFlowSearchHit) => {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? 1 : -1;
  }
  return left.title.localeCompare(right.title);
};

const makeCatalog = Effect.fn("AgentFlowCatalog.make")(function* makeCatalog(
  options: AgentFlowCatalogOptions
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* Ref.make(path.resolve(options.root));
  const writes = Semaphore.makeUnsafe(1);
  const operations = new Map<
    string,
    { readonly input: string; readonly result: AgentFlowRevision }
  >();
  const selectOperations = new Map<
    string,
    { readonly input: string; readonly result: AgentCatalogInfo }
  >();
  const now = options.now ?? (() => new Date());

  const flowsDirectory = (catalogRoot: string) =>
    path.join(catalogRoot, AGENT_FLOWS_DIRECTORY);
  const operationsDirectory = (catalogRoot: string) =>
    path.join(flowsDirectory(catalogRoot), OPERATIONS_DIRECTORY);
  const operationFile = (catalogRoot: string, operationId: string) =>
    path.join(
      operationsDirectory(catalogRoot),
      `sha256-${createHash("sha256").update(operationId).digest("hex")}.json`
    );
  const flowDirectory = (catalogRoot: string, id: AgentFlowId) =>
    path.join(flowsDirectory(catalogRoot), id);
  const revisionDirectory = (
    catalogRoot: string,
    id: AgentFlowId,
    revisionId: AgentFlowRevisionId
  ) =>
    path.join(flowDirectory(catalogRoot, id), REVISIONS_DIRECTORY, revisionId);

  /** Resolve the nearest existing ancestor so symlinked catalog paths cannot
   * redirect a write or read outside the selected root. */
  const isPhysicallyWithinCatalogRoot = (
    catalogRoot: string,
    target: string
  ): Effect.Effect<boolean, AgentFlowCatalogError> =>
    Effect.gen(function* checkCatalogPath() {
      const resolvePath = (value: string) =>
        Effect.gen(function* resolveMissingPath() {
          const missing: string[] = [];
          let probe = path.resolve(value);
          while (true) {
            const exists = yield* fileSystem
              .exists(probe)
              .pipe(
                Effect.mapError(ioError("Could not inspect the Catalog path"))
              );
            if (exists) {
              const resolved = yield* fileSystem
                .realPath(probe)
                .pipe(
                  Effect.mapError(ioError("Could not resolve the Catalog path"))
                );
              return path.join(resolved, ...missing);
            }
            const parent = path.dirname(probe);
            if (parent === probe) {
              return null;
            }
            missing.unshift(path.basename(probe));
            probe = parent;
          }
        });
      const rootPath = yield* resolvePath(catalogRoot);
      const targetPath = yield* resolvePath(target);
      return rootPath !== null && targetPath !== null
        ? isWithinCatalogRoot(rootPath, targetPath)
        : false;
    });

  const ensureCatalogPath = (
    catalogRoot: string,
    target: string,
    what: string
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    isPhysicallyWithinCatalogRoot(catalogRoot, target).pipe(
      Effect.flatMap((safe) =>
        safe
          ? Effect.void
          : Effect.fail(
              catalogError(
                "agent_catalog_invalid",
                `${what} resolves outside the selected Catalog Root.`
              )
            )
      )
    );

  const readJson = <S extends Schema.Top>(
    schema: S,
    file: string,
    what: string,
    catalogRoot?: string
  ): Effect.Effect<S["Type"], AgentFlowCatalogError, S["DecodingServices"]> =>
    (catalogRoot === undefined
      ? Effect.void
      : ensureCatalogPath(catalogRoot, file, what)
    ).pipe(
      Effect.andThen(
        fileSystem
          .readFileString(file)
          .pipe(Effect.mapError(ioError(`Could not read ${what}`)))
      ),
      Effect.flatMap((contents) =>
        Effect.try({
          catch: () =>
            catalogError("agent_catalog_invalid", `${file} is not valid JSON.`),
          try: () => JSON.parse(contents) as unknown,
        })
      ),
      Effect.flatMap((parsed) =>
        Schema.decodeUnknownEffect(schema)(parsed).pipe(
          Effect.mapError((cause) =>
            catalogError(
              "agent_catalog_invalid",
              `${file} is not a valid ${what}: ${cause.message}`
            )
          )
        )
      )
    );

  /**
   * Write through a sibling temporary file and rename it into place, so a
   * reader never sees a half-written manifest or heads record.
   */
  const writeJson = (file: string, contents: string, what: string) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    return ensureCatalogPath(Ref.getUnsafe(root), file, what).pipe(
      Effect.andThen(
        fileSystem
          .writeFileString(temporary, contents)
          .pipe(
            Effect.andThen(fileSystem.rename(temporary, file)),
            Effect.mapError(ioError(`Could not write ${what}`))
          )
      )
    );
  };

  const readCompletedOperation = (
    catalogRoot: string,
    operationId: string
  ): Effect.Effect<AgentFlowOperationRecord | null, AgentFlowCatalogError> => {
    const file = operationFile(catalogRoot, operationId);
    return fileSystem.exists(file).pipe(
      Effect.mapError(ioError("Could not inspect the Agent Flow operation")),
      Effect.flatMap((exists) =>
        exists
          ? readJson(
              AgentFlowOperationRecord,
              file,
              "Agent Flow operation record",
              catalogRoot
            )
          : Effect.succeed(null)
      )
    );
  };

  const validateOperationRecord = (
    catalogRoot: string,
    operationId: string,
    persisted: AgentFlowOperationRecord
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    Effect.gen(function* validatePersistedOperation() {
      const { heads, manifest } = persisted.result;
      const expectedPath = revisionDirectory(
        catalogRoot,
        manifest.agentFlowId,
        manifest.revisionId
      );
      const expectedBasedOn = persisted.expectedHeads?.draftRevisionId ?? null;
      const expectedResultHeads: AgentFlowHeads =
        persisted.expectedHeads === null
          ? {
              approvedRevisionId: null,
              archived: false,
              createdAt: manifest.createdAt,
              draftRevisionId: manifest.revisionId,
              id: manifest.agentFlowId,
              schemaVersion: 1,
              updatedAt: manifest.createdAt,
            }
          : {
              ...persisted.expectedHeads,
              draftRevisionId: manifest.revisionId,
              updatedAt: manifest.createdAt,
            };
      const slicesMatchManifest =
        persisted.slices.length === manifest.steps.length &&
        persisted.slices.every((slice, index) => {
          const step = manifest.steps[index];
          const hash = evidenceHash(slice);
          return (
            step !== undefined &&
            step.evidence.hash === hash &&
            step.evidence.path === `${EVIDENCE_DIRECTORY}/${hash}.json`
          );
        });
      const pathIsSafe = yield* isPhysicallyWithinCatalogRoot(
        catalogRoot,
        expectedPath
      );
      const valid =
        persisted.operationId === operationId &&
        persisted.result.catalogRoot === catalogRoot &&
        persisted.result.path === expectedPath &&
        pathIsSafe &&
        sameHeads(heads, expectedResultHeads) &&
        manifest.basedOnRevisionId === expectedBasedOn &&
        slicesMatchManifest &&
        (persisted.expectedHeads === null ||
          persisted.expectedHeads.id === manifest.agentFlowId);
      if (valid) {
        return;
      }
      return yield* Effect.fail(
        catalogError(
          "agent_catalog_invalid",
          `The persisted Agent Flow operation ${operationId} is outside the selected Catalog Root or has an invalid head transition.`
        )
      );
    });

  const writeOperationRecord = (
    catalogRoot: string,
    operationId: string,
    record: AgentFlowOperationRecord
  ) =>
    Effect.gen(function* writeOperation() {
      yield* ensureCatalogPath(
        catalogRoot,
        operationsDirectory(catalogRoot),
        "Agent Flow operation records"
      );
      yield* fileSystem
        .makeDirectory(operationsDirectory(catalogRoot), { recursive: true })
        .pipe(Effect.mapError(ioError("Could not create operation records")));
      yield* writeJson(
        operationFile(catalogRoot, operationId),
        JSON.stringify(encodeOperation(record), null, 2),
        "the Agent Flow operation record"
      );
    });

  const markOperationCompleted = (
    catalogRoot: string,
    operationId: string,
    record: AgentFlowOperationRecord
  ) =>
    writeOperationRecord(catalogRoot, operationId, {
      ...record,
      status: "completed",
    });

  const writeDraftArtifacts = (
    catalogRoot: string,
    manifest: AgentFlowManifest,
    slices: readonly EvidenceSlice[]
  ) =>
    Effect.gen(function* writeDraftPackage() {
      if (slices.length !== manifest.steps.length) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            "The persisted draft does not contain one Evidence Slice per Agent Step."
          )
        );
      }
      const directory = flowDirectory(catalogRoot, manifest.agentFlowId);
      const revisionPath = revisionDirectory(
        catalogRoot,
        manifest.agentFlowId,
        manifest.revisionId
      );
      yield* Effect.forEach(
        [revisionPath, path.join(directory, EVIDENCE_DIRECTORY)],
        (target) =>
          ensureCatalogPath(catalogRoot, target, "Agent Flow package"),
        { discard: true }
      );
      yield* Effect.forEach(
        [revisionPath, path.join(directory, EVIDENCE_DIRECTORY)],
        (target) =>
          fileSystem
            .makeDirectory(target, { recursive: true })
            .pipe(Effect.mapError(ioError("Could not create the revision"))),
        { discard: true }
      );
      for (const [index, slice] of slices.entries()) {
        const step = manifest.steps[index];
        const hash = evidenceHash(slice);
        const relative = `${EVIDENCE_DIRECTORY}/${hash}.json`;
        if (
          step === undefined ||
          step.evidence.hash !== hash ||
          step.evidence.path !== relative
        ) {
          return yield* Effect.fail(
            catalogError(
              "agent_catalog_invalid",
              `The persisted Evidence Slice ${index} does not match its Agent Step.`
            )
          );
        }
        const file = path.join(directory, relative);
        const present = yield* fileSystem
          .exists(file)
          .pipe(Effect.mapError(ioError("Could not inspect evidence")));
        if (present) {
          const existing = yield* readJson(
            EvidenceSlice,
            file,
            "Evidence Slice",
            catalogRoot
          );
          if (evidenceHash(existing) !== hash) {
            return yield* Effect.fail(
              catalogError(
                "agent_catalog_invalid",
                `The persisted Evidence Slice ${hash} does not match its content.`
              )
            );
          }
        } else {
          yield* writeJson(
            file,
            JSON.stringify(encodeSlice(slice), null, 2),
            "an Evidence Slice"
          );
        }
      }
      const manifestFile = path.join(revisionPath, MANIFEST_FILE);
      const manifestPresent = yield* fileSystem
        .exists(manifestFile)
        .pipe(Effect.mapError(ioError("Could not inspect the revision")));
      if (manifestPresent) {
        const existing = yield* readJson(
          AgentFlowManifest,
          manifestFile,
          "Agent Flow manifest",
          catalogRoot
        );
        if (
          canonicalJson(encodeManifest(existing)) !==
          canonicalJson(encodeManifest(manifest))
        ) {
          return yield* Effect.fail(
            catalogError(
              "agent_catalog_invalid",
              `The persisted Agent Flow manifest does not match its operation.`
            )
          );
        }
      } else {
        yield* writeJson(
          manifestFile,
          JSON.stringify(encodeManifest(manifest), null, 2),
          "the Agent Flow manifest"
        );
      }
    });

  const writePendingOperation = (
    catalogRoot: string,
    pending: AgentFlowOperationRecord | null
  ) =>
    pending === null
      ? Effect.void
      : writeOperationRecord(catalogRoot, pending.operationId, pending);

  const commitDraft = (
    catalogRoot: string,
    headsFile: string,
    heads: AgentFlowHeads,
    expectedHeads: AgentFlowHeads | null,
    pending: AgentFlowOperationRecord | null
  ) =>
    Effect.gen(function* commitDraftWithReplay() {
      const currentExists = yield* fileSystem
        .exists(headsFile)
        .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
      const current = currentExists
        ? yield* readJson(
            AgentFlowHeads,
            headsFile,
            "Agent Flow record",
            catalogRoot
          )
        : null;
      if (!matchesExpectedHeads(expectedHeads, current)) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Agent Flow ${heads.id} head moved while this draft was written. Reread it before proposing another revision.`
          )
        );
      }
      yield* writeJson(
        headsFile,
        JSON.stringify(encodeHeads(heads), null, 2),
        "the Agent Flow record"
      );
      if (pending !== null) {
        yield* markOperationCompleted(
          catalogRoot,
          pending.operationId,
          pending
        );
      }
    });

  const replayPersistedOperation = (
    catalogRoot: string,
    operationId: string,
    requestInput?: string
  ): Effect.Effect<AgentFlowRevision | null, AgentFlowCatalogError> =>
    readCompletedOperation(catalogRoot, operationId).pipe(
      Effect.flatMap((persisted) => {
        if (persisted === null) {
          return Effect.succeed(null);
        }
        return Effect.gen(function* replayPendingOperation() {
          yield* validateOperationRecord(catalogRoot, operationId, persisted);
          if (requestInput !== undefined && persisted.input !== requestInput) {
            return yield* Effect.fail(
              catalogError(
                "agent_flow_conflict",
                `Operation ${operationId} was already used to save a different draft.`
              )
            );
          }
          if (persisted.status === "completed") {
            return persisted.result;
          }

          const { heads: intendedHeads, manifest } = persisted.result;
          const headsFile = path.join(
            flowDirectory(catalogRoot, manifest.agentFlowId),
            HEADS_FILE
          );
          const exists = yield* fileSystem
            .exists(headsFile)
            .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
          const current: AgentFlowHeads | null = exists
            ? yield* readJson(
                AgentFlowHeads,
                headsFile,
                "Agent Flow record",
                catalogRoot
              )
            : null;
          if (
            current !== null &&
            current.id === intendedHeads.id &&
            current.draftRevisionId === manifest.revisionId
          ) {
            yield* writeDraftArtifacts(catalogRoot, manifest, persisted.slices);
            yield* markOperationCompleted(catalogRoot, operationId, persisted);
            return persisted.result;
          }

          const expected = persisted.expectedHeads;
          if (!matchesExpectedHeads(expected, current)) {
            return yield* Effect.fail(
              catalogError(
                "agent_flow_conflict",
                `Operation ${operationId} cannot recover because the Agent Flow head changed.`
              )
            );
          }
          yield* writeDraftArtifacts(catalogRoot, manifest, persisted.slices);
          yield* writeJson(
            headsFile,
            JSON.stringify(encodeHeads(intendedHeads), null, 2),
            "the Agent Flow record"
          );
          yield* markOperationCompleted(catalogRoot, operationId, persisted);
          return persisted.result;
        });
      })
    );

  const replayOperation = (
    catalogRoot: string,
    operationId: string | undefined,
    requestInput: string
  ): Effect.Effect<AgentFlowRevision | null, AgentFlowCatalogError> => {
    if (operationId === undefined) {
      return Effect.succeed(null);
    }
    const prior = operations.get(operationCacheKey(catalogRoot, operationId));
    if (prior === undefined) {
      return replayPersistedOperation(catalogRoot, operationId, requestInput);
    }
    return prior.input === requestInput
      ? Effect.succeed(prior.result)
      : Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Operation ${operationId} was already used to save a different draft.`
          )
        );
  };

  const catalogLockConflict = (catalogRoot: string) =>
    catalogError(
      "agent_flow_conflict",
      `The Agent Flow Catalog at ${catalogRoot} is being mutated by another process.`
    );

  /** Serialize catalog mutations across independent MCP processes. */
  const withCatalogLock = <A>(
    catalogRoot: string,
    operation: Effect.Effect<A, AgentFlowCatalogError>
  ): Effect.Effect<A, AgentFlowCatalogError> => {
    const lockPath = path.join(flowsDirectory(catalogRoot), ".catalog.lock");
    const conflict = catalogLockConflict(catalogRoot);
    const create = fileSystem
      .writeFileString(lockPath, `${process.pid}\n`, { flag: "wx" })
      .pipe(Effect.mapError(() => conflict));
    return Effect.gen(function* acquireCatalogLock() {
      const firstAttempt = yield* Effect.result(create);
      if (Result.isSuccess(firstAttempt)) {
        return yield* operation.pipe(
          Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
        );
      }

      // A process that died while holding the lock leaves only its PID behind.
      // Preserve malformed/foreign locks and any lock whose owner is alive.
      const observed = yield* fileSystem
        .readFileString(lockPath)
        .pipe(Effect.mapError(() => conflict));
      const pid = lockOwnerPid(observed);
      if (pid === undefined || !processIsStale(pid)) {
        return yield* Effect.fail(conflict);
      }
      const confirmed = yield* fileSystem
        .readFileString(lockPath)
        .pipe(Effect.mapError(() => conflict));
      if (confirmed !== observed) {
        return yield* Effect.fail(conflict);
      }
      yield* fileSystem.remove(lockPath).pipe(Effect.mapError(() => conflict));
      const retry = yield* Effect.result(create);
      if (Result.isFailure(retry)) {
        return yield* Effect.fail(conflict);
      }
      return yield* operation.pipe(
        Effect.ensuring(fileSystem.remove(lockPath).pipe(Effect.ignore))
      );
    });
  };

  const listFlowIds = (
    catalogRoot: string
  ): Effect.Effect<AgentFlowId[], AgentFlowCatalogError> =>
    Effect.gen(function* listCatalogFlows() {
      const exists = yield* fileSystem
        .exists(flowsDirectory(catalogRoot))
        .pipe(
          Effect.mapError(ioError("Could not inspect the Agent Flow Catalog"))
        );
      if (!exists) {
        return [];
      }
      yield* ensureCatalogPath(
        catalogRoot,
        flowsDirectory(catalogRoot),
        "Agent Flow Catalog"
      );
      const entries = yield* fileSystem
        .readDirectory(flowsDirectory(catalogRoot))
        .pipe(
          Effect.mapError(ioError("Could not list the Agent Flow Catalog"))
        );
      const ids = entries
        .filter((entry) => Schema.is(AgentFlowId)(entry))
        .map((entry) => AgentFlowId.make(entry));
      const present = yield* Effect.forEach(
        ids,
        (id) =>
          fileSystem
            .exists(path.join(flowDirectory(catalogRoot, id), HEADS_FILE))
            .pipe(
              Effect.mapError(ioError("Could not inspect the Agent Flow")),
              Effect.map((headsExist) => (headsExist ? id : undefined))
            ),
        { discard: false }
      );
      return present
        .filter((id): id is AgentFlowId => id !== undefined)
        .toSorted();
    });

  const readHeads = (catalogRoot: string, id: AgentFlowId) =>
    readJson(
      AgentFlowHeads,
      path.join(flowDirectory(catalogRoot, id), HEADS_FILE),
      "Agent Flow record",
      catalogRoot
    );

  const readManifest = (
    catalogRoot: string,
    id: AgentFlowId,
    revisionId: AgentFlowRevisionId
  ) =>
    readJson(
      AgentFlowManifest,
      path.join(revisionDirectory(catalogRoot, id, revisionId), MANIFEST_FILE),
      "Agent Flow manifest",
      catalogRoot
    );

  const revision = (
    catalogRoot: string,
    heads: AgentFlowHeads,
    manifest: AgentFlowManifest
  ): AgentFlowRevision => ({
    catalogRoot,
    heads,
    manifest,
    path: revisionDirectory(catalogRoot, heads.id, manifest.revisionId),
  });

  const info = (
    catalogRoot: string
  ): Effect.Effect<AgentCatalogInfo, AgentFlowCatalogError> =>
    listFlowIds(catalogRoot).pipe(
      Effect.map((ids) => ({ agentFlowCount: ids.length, root: catalogRoot }))
    );

  const select = Effect.fn("AgentFlowCatalog.select")(function* selectRoot(
    requested: string,
    operationId?: OperationId | string
  ) {
    const requestInput = canonicalJson({ root: requested });
    const operationKey =
      operationId === undefined ? undefined : String(operationId);
    const prior =
      operationKey === undefined
        ? undefined
        : selectOperations.get(operationKey);
    if (prior !== undefined) {
      if (prior.input === requestInput) {
        yield* Ref.set(root, prior.result.root);
        options.onSelect?.(prior.result.root);
        return prior.result;
      }
      return yield* Effect.fail(
        catalogError(
          "agent_flow_conflict",
          `Operation ${operationKey} was already used to select a different Catalog Root.`
        )
      );
    }
    if (!path.isAbsolute(requested)) {
      return yield* Effect.fail(
        catalogError(
          "agent_catalog_invalid",
          `A Catalog Root must be an absolute path; received "${requested}".`
        )
      );
    }
    const resolved = path.resolve(requested);
    const exists = yield* fileSystem
      .exists(resolved)
      .pipe(Effect.mapError(ioError("Could not inspect the Catalog Root")));
    if (exists) {
      const stat = yield* fileSystem
        .stat(resolved)
        .pipe(Effect.mapError(ioError("Could not inspect the Catalog Root")));
      if (stat.type !== "Directory") {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            `${resolved} exists and is not a directory.`
          )
        );
      }
    }
    yield* Ref.set(root, resolved);
    const selected = yield* info(resolved);
    options.onSelect?.(resolved);
    if (operationKey !== undefined) {
      selectOperations.set(operationKey, {
        input: requestInput,
        result: selected,
      });
    }
    return selected;
  });

  const get = Effect.fn("AgentFlowCatalog.get")(function* getRevision(
    agentFlowId: AgentFlowId,
    revisionId?: AgentFlowRevisionId
  ) {
    const catalogRoot = yield* Ref.get(root);
    const exists = yield* fileSystem
      .exists(path.join(flowDirectory(catalogRoot, agentFlowId), HEADS_FILE))
      .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
    if (!exists) {
      return yield* Effect.fail(
        catalogError(
          "agent_flow_not_found",
          `Agent Flow ${agentFlowId} is not in the catalog at ${catalogRoot}.`
        )
      );
    }
    const heads = yield* readHeads(catalogRoot, agentFlowId);
    const target =
      revisionId ?? heads.draftRevisionId ?? heads.approvedRevisionId;
    if (target === null) {
      return yield* Effect.fail(
        catalogError(
          "agent_flow_not_found",
          `Agent Flow ${agentFlowId} has no revision to read.`
        )
      );
    }
    const manifestExists = yield* fileSystem
      .exists(
        path.join(
          revisionDirectory(catalogRoot, agentFlowId, target),
          MANIFEST_FILE
        )
      )
      .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
    if (!manifestExists) {
      return yield* Effect.fail(
        catalogError(
          "agent_flow_not_found",
          `Agent Flow ${agentFlowId} has no revision ${target}.`
        )
      );
    }
    const manifest = yield* readManifest(catalogRoot, agentFlowId, target);
    return revision(catalogRoot, heads, manifest);
  });

  /** The heads of one Agent Flow, skipping packages that fail to decode. */
  const liveManifests = (
    catalogRoot: string,
    id: AgentFlowId
  ): Effect.Effect<
    readonly {
      readonly archived: boolean;
      readonly manifest: AgentFlowManifest;
    }[],
    never
  > =>
    Effect.gen(function* readLiveHeads() {
      const heads = yield* readHeads(catalogRoot, id);
      const ids = [heads.approvedRevisionId, heads.draftRevisionId].filter(
        (revisionId, index, all): revisionId is AgentFlowRevisionId =>
          revisionId !== null && all.indexOf(revisionId) === index
      );
      const manifests = yield* Effect.all(
        ids.map((revisionId) => readManifest(catalogRoot, id, revisionId))
      );
      return manifests.map((manifest) => ({
        archived: heads.archived,
        manifest,
      }));
    }).pipe(
      Effect.orElseSucceed(
        (): readonly {
          readonly archived: boolean;
          readonly manifest: AgentFlowManifest;
        }[] => []
      )
    );

  const search = Effect.fn("AgentFlowCatalog.search")(function* searchCatalog(
    query: AgentFlowSearch
  ) {
    const catalogRoot = yield* Ref.get(root);
    const ids = yield* listFlowIds(catalogRoot);
    const manifests = yield* Effect.all(
      ids.map((id) => liveManifests(catalogRoot, id))
    );
    const hits: AgentFlowSearchHit[] = [];
    for (const { archived, manifest } of manifests.flat()) {
      if (archived !== (query.archived ?? false)) {
        continue;
      }
      if (query.status !== undefined && manifest.status !== query.status) {
        continue;
      }
      if (
        query.tag !== undefined &&
        !manifest.tags.some(
          (tag) => tag.toLowerCase() === query.tag?.toLowerCase()
        )
      ) {
        continue;
      }
      if (
        query.host !== undefined &&
        !manifest.domainScope.hosts.some((entry) =>
          domainScopeCovers(
            entry.toLowerCase(),
            query.host?.toLowerCase() ?? ""
          )
        )
      ) {
        continue;
      }
      const scored = scoreManifest(manifest, query.query);
      if (scored === undefined) {
        continue;
      }
      hits.push({
        agentFlowId: manifest.agentFlowId,
        archived,
        createdAt: manifest.createdAt,
        description: manifest.description,
        hosts: manifest.domainScope.hosts,
        matchedFields: scored.matchedFields,
        revisionId: manifest.revisionId,
        score: scored.score,
        status: manifest.status,
        stepCount: manifest.steps.length,
        tags: manifest.tags,
        title: manifest.title,
      });
    }
    hits.sort(compareHits);
    return {
      catalogRoot,
      hits: hits.slice(0, query.limit ?? DEFAULT_SEARCH_LIMIT),
    } satisfies AgentFlowSearchResult;
  });

  const saveDraftUnlocked = Effect.fn("AgentFlowCatalog.saveDraft")(
    function* saveDraft(input: SaveDraftInput) {
      const requestInput = normalizedDraftSaveInput(input);
      const operationKey =
        input.operationId === undefined ? undefined : String(input.operationId);
      const catalogRoot = yield* Ref.get(root);
      const replay = yield* replayOperation(
        catalogRoot,
        operationKey,
        requestInput
      );
      if (replay !== null) {
        if (operationKey !== undefined) {
          operations.set(operationCacheKey(catalogRoot, operationKey), {
            input: requestInput,
            result: replay,
          });
        }
        return replay;
      }
      if (input.slices.length !== input.proposal.steps.length) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            "Every Agent Step needs exactly one Evidence Slice."
          )
        );
      }
      const at = now().toISOString();
      const agentFlowId =
        input.agentFlowId ?? AgentFlowId.make(`flow-${randomUUID()}`);
      const directory = flowDirectory(catalogRoot, agentFlowId);
      const headsFile = path.join(directory, HEADS_FILE);
      const headsExist = yield* fileSystem
        .exists(headsFile)
        .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
      if (input.agentFlowId !== undefined && !headsExist) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_not_found",
            `Agent Flow ${agentFlowId} is not in the catalog at ${catalogRoot}.`
          )
        );
      }
      const existing: AgentFlowHeads = headsExist
        ? yield* readHeads(catalogRoot, agentFlowId)
        : {
            approvedRevisionId: null,
            archived: false,
            createdAt: at,
            draftRevisionId: null,
            id: agentFlowId,
            schemaVersion: 1,
            updatedAt: at,
          };
      const expectedHeads = headsExist ? existing : null;
      if (existing.draftRevisionId !== input.basedOnRevisionId) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            existing.draftRevisionId === null
              ? `Agent Flow ${agentFlowId} has no draft revision; save a new draft with basedOnRevisionId null.`
              : `Agent Flow ${agentFlowId} draft head is ${existing.draftRevisionId}, not ${String(input.basedOnRevisionId)}. Reread it before proposing another revision.`
          )
        );
      }
      const revisionId = AgentFlowRevisionId.make(`rev-${randomUUID()}`);
      const steps = yield* Effect.all(
        input.slices.map((slice, index) => {
          const step = input.proposal.steps[index];
          if (step === undefined) {
            return Effect.fail(
              catalogError(
                "agent_catalog_invalid",
                `Evidence Slice ${index} has no Agent Step.`
              )
            );
          }
          const hash = evidenceHash(slice);
          return Effect.succeed({
            confirmation: step.confirmation,
            description: step.description,
            evidence: {
              hash,
              path: `${EVIDENCE_DIRECTORY}/${hash}.json`,
            },
            index,
            name: step.name,
          });
        })
      );
      const manifest: AgentFlowManifest = {
        agentFlowId,
        basedOnRevisionId: input.basedOnRevisionId,
        compiler: input.compiler,
        createdAt: at,
        description: input.proposal.description,
        domainScope: {
          hosts: input.proposal.domainScope.hosts.map((host) =>
            host.toLowerCase()
          ),
        },
        emulation: input.emulation,
        revisionId,
        schemaVersion: 1,
        sourceSessionId: input.sourceSessionId,
        status: "draft",
        steps,
        tags: input.proposal.tags ?? [],
        title: input.proposal.title,
        variables: input.proposal.variables ?? [],
      };
      // Re-read the heads right before moving them: another process may have
      // advanced the draft before the write-ahead record is created.
      const currentExists = yield* fileSystem
        .exists(headsFile)
        .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
      const current = currentExists
        ? yield* readHeads(catalogRoot, agentFlowId)
        : null;
      if (!matchesExpectedHeads(expectedHeads, current)) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Agent Flow ${agentFlowId} head moved while this draft was written. Reread it before proposing another revision.`
          )
        );
      }
      const heads: AgentFlowHeads = {
        ...(expectedHeads ?? existing),
        draftRevisionId: revisionId,
        updatedAt: at,
      };
      const saved = revision(catalogRoot, heads, manifest);
      const pending =
        operationKey === undefined
          ? null
          : operationRecord(
              "pending",
              operationKey,
              requestInput,
              expectedHeads,
              saved,
              input.slices
            );
      yield* writePendingOperation(catalogRoot, pending);
      yield* writeDraftArtifacts(catalogRoot, manifest, input.slices);
      yield* commitDraft(catalogRoot, headsFile, heads, expectedHeads, pending);
      if (operationKey !== undefined) {
        operations.set(operationCacheKey(catalogRoot, operationKey), {
          input: requestInput,
          result: saved,
        });
      }
      return saved;
    }
  );

  const service: AgentFlowCatalogService = {
    get: (agentFlowId, revisionId) => get(agentFlowId, revisionId),
    info: () => Ref.get(root).pipe(Effect.flatMap(info)),
    replayDraftSave: (operationId, requestInput) =>
      writes.withPermit(
        Effect.gen(function* replayDraftSaveWithCatalogLock() {
          const catalogRoot = yield* Ref.get(root);
          yield* ensureCatalogPath(
            catalogRoot,
            flowsDirectory(catalogRoot),
            "Agent Flow Catalog"
          );
          yield* fileSystem
            .makeDirectory(flowsDirectory(catalogRoot), { recursive: true })
            .pipe(
              Effect.mapError(
                ioError("Could not create the Agent Flow Catalog")
              )
            );
          return yield* withCatalogLock(
            catalogRoot,
            replayPersistedOperation(
              catalogRoot,
              String(operationId),
              requestInput
            )
          );
        })
      ),
    saveDraft: (input) =>
      writes.withPermit(
        Effect.gen(function* saveDraftWithCatalogLock() {
          const catalogRoot = yield* Ref.get(root);
          yield* ensureCatalogPath(
            catalogRoot,
            flowsDirectory(catalogRoot),
            "Agent Flow Catalog"
          );
          yield* fileSystem
            .makeDirectory(flowsDirectory(catalogRoot), { recursive: true })
            .pipe(
              Effect.mapError(
                ioError("Could not create the Agent Flow Catalog")
              )
            );
          return yield* withCatalogLock(catalogRoot, saveDraftUnlocked(input));
        })
      ),
    search: (query) => search(query),
    select: (requested, operationId) =>
      writes.withPermit(select(requested, operationId)),
  };
  return service;
});

export const makeAgentFlowCatalogLayer = (
  options: AgentFlowCatalogOptions
): Layer.Layer<AgentFlowCatalogService, never, FileSystem.FileSystem> =>
  Layer.effect(AgentFlowCatalog, makeCatalog(options));
