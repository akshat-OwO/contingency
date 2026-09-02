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
  input: Schema.String,
  operationId: OperationId,
  result: AgentFlowRevision,
  schemaVersion: Schema.Literal(1),
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

const encodeSlice = Schema.encodeSync(EvidenceSlice);
const encodeManifest = Schema.encodeSync(AgentFlowManifest);
const encodeHeads = Schema.encodeSync(AgentFlowHeads);
const encodeOperation = Schema.encodeSync(AgentFlowOperationRecord);

export const evidenceHash = (slice: EvidenceSlice): EvidenceHash =>
  EvidenceHash.make(
    `sha256-${createHash("sha256")
      .update(canonicalJson(encodeSlice(slice)))
      .digest("hex")}`
  );

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

  const readJson = <S extends Schema.Top>(
    schema: S,
    file: string,
    what: string
  ): Effect.Effect<S["Type"], AgentFlowCatalogError, S["DecodingServices"]> =>
    fileSystem.readFileString(file).pipe(
      Effect.mapError(ioError(`Could not read ${what}`)),
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
    return fileSystem
      .writeFileString(temporary, contents)
      .pipe(
        Effect.andThen(fileSystem.rename(temporary, file)),
        Effect.mapError(ioError(`Could not write ${what}`))
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
              "Agent Flow operation record"
            )
          : Effect.succeed(null)
      )
    );
  };

  const replayPersistedOperation = (
    catalogRoot: string,
    operationId: string,
    requestInput: string
  ): Effect.Effect<AgentFlowRevision | null, AgentFlowCatalogError> =>
    readCompletedOperation(catalogRoot, operationId).pipe(
      Effect.flatMap((persisted) => {
        if (persisted === null) {
          return Effect.succeed(null);
        }
        if (
          persisted.operationId !== operationId ||
          persisted.result.catalogRoot !== catalogRoot ||
          !isWithinCatalogRoot(catalogRoot, persisted.result.path)
        ) {
          return Effect.fail(
            catalogError(
              "agent_catalog_invalid",
              `The persisted Agent Flow operation ${operationId} is outside the selected Catalog Root.`
            )
          );
        }
        if (persisted.input === requestInput) {
          return Effect.succeed(persisted.result);
        }
        return Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Operation ${operationId} was already used to save a different draft.`
          )
        );
      })
    );

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
    fileSystem.exists(flowsDirectory(catalogRoot)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.readDirectory(flowsDirectory(catalogRoot))
          : Effect.succeed([])
      ),
      Effect.mapError(ioError("Could not list the Agent Flow Catalog")),
      Effect.map((entries) =>
        entries
          .filter((entry) => Schema.is(AgentFlowId)(entry))
          .map((entry) => AgentFlowId.make(entry))
          .toSorted()
      )
    );

  const readHeads = (catalogRoot: string, id: AgentFlowId) =>
    readJson(
      AgentFlowHeads,
      path.join(flowDirectory(catalogRoot, id), HEADS_FILE),
      "Agent Flow record"
    );

  const readManifest = (
    catalogRoot: string,
    id: AgentFlowId,
    revisionId: AgentFlowRevisionId
  ) =>
    readJson(
      AgentFlowManifest,
      path.join(revisionDirectory(catalogRoot, id, revisionId), MANIFEST_FILE),
      "Agent Flow manifest"
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

  const normalizedSaveInput = (input: SaveDraftInput): string =>
    canonicalJson({
      agentFlowId: input.agentFlowId ?? null,
      basedOnRevisionId: input.basedOnRevisionId,
      proposal: input.proposal,
      sessionId: input.sourceSessionId,
      slices: input.slices.map(evidenceHash),
    });

  const saveDraftUnlocked = Effect.fn("AgentFlowCatalog.saveDraft")(
    function* saveDraft(input: SaveDraftInput) {
      const requestInput = normalizedSaveInput(input);
      const operationKey =
        input.operationId === undefined ? undefined : String(input.operationId);
      const catalogRoot = yield* Ref.get(root);
      const prior =
        operationKey === undefined ? undefined : operations.get(operationKey);
      if (prior !== undefined) {
        if (prior.input === requestInput) {
          return prior.result;
        }
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Operation ${operationKey} was already used to save a different draft.`
          )
        );
      }
      if (operationKey !== undefined) {
        const replay = yield* replayPersistedOperation(
          catalogRoot,
          operationKey,
          requestInput
        );
        if (replay !== null) {
          operations.set(operationKey, { input: requestInput, result: replay });
          return replay;
        }
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
      const revisionPath = revisionDirectory(
        catalogRoot,
        agentFlowId,
        revisionId
      );
      const evidenceDirectory = path.join(directory, EVIDENCE_DIRECTORY);
      yield* Effect.forEach(
        [revisionPath, evidenceDirectory],
        (target) =>
          fileSystem
            .makeDirectory(target, { recursive: true })
            .pipe(Effect.mapError(ioError("Could not create the revision"))),
        { discard: true }
      );
      const writeSlice = (slice: EvidenceSlice, index: number) =>
        Effect.gen(function* writeEvidenceSlice() {
          const hash = evidenceHash(slice);
          const relative = `${EVIDENCE_DIRECTORY}/${hash}.json`;
          const file = path.join(directory, relative);
          // Evidence is content-addressed: an unchanged slice from an earlier
          // revision is the same file, so it is never rewritten.
          const present = yield* fileSystem
            .exists(file)
            .pipe(Effect.mapError(ioError("Could not inspect evidence")));
          if (!present) {
            yield* writeJson(
              file,
              JSON.stringify(encodeSlice(slice), null, 2),
              "an Evidence Slice"
            );
          }
          const step = input.proposal.steps[index];
          if (step === undefined) {
            return yield* Effect.fail(
              catalogError(
                "agent_catalog_invalid",
                `Evidence Slice ${index} has no Agent Step.`
              )
            );
          }
          return {
            confirmation: step.confirmation,
            description: step.description,
            evidence: { hash, path: relative },
            index,
            name: step.name,
          };
        });
      const steps = yield* Effect.all(input.slices.map(writeSlice));
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
      yield* writeJson(
        path.join(revisionPath, MANIFEST_FILE),
        JSON.stringify(encodeManifest(manifest), null, 2),
        "the Agent Flow manifest"
      );
      // Re-read the heads right before moving them: another process may have
      // advanced the draft while the package was written. The package stays
      // on disk either way; only the head decides what the catalog offers.
      const current: AgentFlowHeads = headsExist
        ? yield* readHeads(catalogRoot, agentFlowId)
        : existing;
      if (current.draftRevisionId !== input.basedOnRevisionId) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Agent Flow ${agentFlowId} draft head moved to ${String(current.draftRevisionId)} while this draft was written. Reread it before proposing another revision.`
          )
        );
      }
      const heads: AgentFlowHeads = {
        ...current,
        draftRevisionId: revisionId,
        updatedAt: at,
      };
      yield* writeJson(
        headsFile,
        JSON.stringify(encodeHeads(heads), null, 2),
        "the Agent Flow record"
      );
      const saved = revision(catalogRoot, heads, manifest);
      if (operationKey !== undefined) {
        yield* fileSystem
          .makeDirectory(operationsDirectory(catalogRoot), { recursive: true })
          .pipe(Effect.mapError(ioError("Could not create operation records")));
        yield* writeJson(
          operationFile(catalogRoot, operationKey),
          JSON.stringify(
            encodeOperation({
              input: requestInput,
              operationId: OperationId.make(operationKey),
              result: saved,
              schemaVersion: 1,
            }),
            null,
            2
          ),
          "the Agent Flow operation record"
        );
        operations.set(operationKey, { input: requestInput, result: saved });
      }
      return saved;
    }
  );

  const service: AgentFlowCatalogService = {
    get: (agentFlowId, revisionId) => get(agentFlowId, revisionId),
    info: () => Ref.get(root).pipe(Effect.flatMap(info)),
    saveDraft: (input) =>
      writes.withPermit(
        Effect.gen(function* saveDraftWithCatalogLock() {
          const catalogRoot = yield* Ref.get(root);
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
