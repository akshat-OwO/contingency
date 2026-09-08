import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AgentFlowHeads,
  AgentFlowId,
  AgentFlowManifest,
  AgentFlowRevision,
  AgentFlowRevisionId,
  AgentFlowDeleteResult,
  EvidenceHash,
  EvidenceSlice,
  OperationId,
  StoredAgentFlowManifest,
  StoredEvidenceSlice,
  StoredEvidenceSliceV1,
} from "@contingency/protocol";
import type {
  AgentCatalogInfo,
  AgentFlowCompiler,
  AgentFlowDraftProposal,
  AgentFlowExpectedHeads,
  AgentFlowSearch,
  AgentFlowSearchHit,
  AgentFlowSearchResult,
  AgentFlowVerification,
  AgentFlowVerificationOutcome,
  AgentFlowVerificationStepAssessment,
  AgentSessionId,
  AgentStep,
  DraftEmulation,
  StoredAgentStepV1,
  TeachingScreenshotContent,
} from "@contingency/protocol";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  SCREENSHOTS_DIRECTORY,
  domainScopeCovers,
} from "./agent-flow-compiler.ts";

/** The directory under a Catalog Root that holds Agent Flow packages. */
export const AGENT_FLOWS_DIRECTORY = "agent-flows";
const HEADS_FILE = "agent-flow.json";
const REVISIONS_DIRECTORY = "revisions";
const EVIDENCE_DIRECTORY = "evidence";
const MANIFEST_FILE = "manifest.json";
const SOURCE_ARTIFACTS_FILE = "source-artifacts.json";
const OPERATIONS_DIRECTORY = ".operations";
const DEFAULT_SEARCH_LIMIT = 20;
export const CATALOG_CONFIG_FILE = "agent-flow-catalog.json";

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

const ProcessError = Schema.Struct({ code: Schema.optional(Schema.String) });
const RetentionDeadline = Schema.Struct({
  deleteAfter: Schema.String,
  retention: Schema.Literal("retain-for-days"),
});
const RetentionMetadata = Schema.Struct({
  approvedAt: Schema.optional(Schema.String),
  deleteAfter: Schema.optional(Schema.String),
  files: Schema.optional(
    Schema.Struct({
      trace: Schema.String,
      videos: Schema.Array(Schema.String),
    })
  ),
  retention: Schema.optional(
    Schema.Literals([
      "delete-on-approval",
      "expired",
      "local",
      "retain-for-days",
    ])
  ),
  sensitive: Schema.optional(Schema.Boolean),
});

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
    return Schema.decodeUnknownOption(ProcessError)(error).pipe(
      Option.exists(({ code }) => code === "ESRCH")
    );
  }
};

const retentionDeadline = (contents: string): number | null => {
  try {
    const metadata = Schema.decodeUnknownOption(RetentionDeadline)(
      JSON.parse(contents)
    );
    if (Option.isNone(metadata)) {
      return null;
    }
    const deadline = Date.parse(metadata.value.deleteAfter);
    return Number.isNaN(deadline) ? null : deadline;
  } catch {
    return null;
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
  /**
   * The bytes behind the screenshots the slices reference. They are stored
   * once under their content address; a hash the package already holds is not
   * written again.
   */
  readonly screenshots?: readonly TeachingScreenshotContent[] | undefined;
  readonly slices: readonly EvidenceSlice[];
  /** Local-only sensitive Teaching artifacts governed when this draft passes. */
  readonly sourceArtifacts?:
    | {
        readonly retentionFile?: string | undefined;
        readonly traceFile?: string | undefined;
        readonly videoFile?: string | undefined;
      }
    | undefined;
  readonly sourceSessionId: AgentSessionId;
}

/** What a head mutation names. Every one of them is one exact revision. */
export interface RevisionOperationInput {
  readonly agentFlowId: AgentFlowId;
  readonly operationId: OperationId | string;
  readonly revisionId: AgentFlowRevisionId;
}

export interface AuthorizeVerificationInput extends RevisionOperationInput {
  /**
   * The page the authorizing Agent Session was showing, sanitized. The
   * Verification Run opens there in its own fresh browser context.
   */
  readonly startingUrl?: string | null | undefined;
}

export interface StartVerificationInput extends RevisionOperationInput {
  readonly sessionId: AgentSessionId;
}

export interface CompleteVerificationInput extends RevisionOperationInput {
  readonly assessments: readonly AgentFlowVerificationStepAssessment[];
  readonly outcome: AgentFlowVerificationOutcome;
  readonly summary: string;
}

export interface SetArchivedInput {
  readonly agentFlowId: AgentFlowId;
  readonly archived: boolean;
  readonly expectedHeads: AgentFlowExpectedHeads;
  readonly operationId: OperationId | string;
}

export interface DeleteAgentFlowInput {
  readonly agentFlowId: AgentFlowId;
  readonly confirmation: string;
  readonly expectedHeads: AgentFlowExpectedHeads;
  readonly operationId: OperationId | string;
}

export interface AgentFlowCatalogService {
  /**
   * The Evidence Slices behind one revision's Agent Steps, in Step order.
   * Draft review reads them to show what verification would authorize.
   */
  readonly evidence: (
    agentFlowId: AgentFlowId,
    revisionId?: AgentFlowRevisionId
  ) => Effect.Effect<readonly StoredEvidenceSlice[], AgentFlowCatalogError>;
  /**
   * Record one direct user authorization of one Verification Run for one exact
   * draft revision. Every draft mutation clears it, so a corrected draft is
   * authorized again rather than inheriting the previous gesture
   * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
   */
  readonly authorizeVerification: (
    input: AuthorizeVerificationInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /** Spend the authorization on one Verification Run. */
  readonly startVerification: (
    input: StartVerificationInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /** Record how that Run ended. A failure leaves the approved revision alone. */
  readonly completeVerification: (
    input: CompleteVerificationInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /**
   * Turn one successfully verified draft revision into the Approved Agent
   * Flow. Only a direct Agent View gesture reaches this
   * ([ADR 0028](../../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
   */
  readonly approve: (
    input: RevisionOperationInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /** Archive is recoverable and is the normal way to retire an Agent Flow. */
  readonly setArchived: (
    input: SetArchivedInput
  ) => Effect.Effect<AgentFlowRevision, AgentFlowCatalogError>;
  /**
   * Irreversible removal. Only Agent View exposes this capability, and the
   * direct user request must carry the exact confirmation phrase.
   */
  readonly deletePermanently: (
    input: DeleteAgentFlowInput
  ) => Effect.Effect<AgentFlowDeleteResult, AgentFlowCatalogError>;
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

/**
 * A head mutation's write-ahead record: what it was asked to do, the heads it
 * expected to move, and the result it produced. A repeated operation id
 * answers with that result instead of moving the heads a second time.
 */
export const AgentFlowHeadOperationRecord = Schema.Struct({
  expectedHeads: AgentFlowHeads,
  input: Schema.String,
  operationId: OperationId,
  result: AgentFlowRevision,
  schemaVersion: Schema.Literal(1),
  writeManifest: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true))
  ),
});
type AgentFlowHeadOperationRecord = typeof AgentFlowHeadOperationRecord.Type;

const SourceArtifacts = Schema.Struct({
  retentionFile: Schema.optional(Schema.String),
  traceFile: Schema.optional(Schema.String),
  videoFile: Schema.optional(Schema.String),
});
type SourceArtifacts = typeof SourceArtifacts.Type;

export const AgentFlowOperationRecord = Schema.Struct({
  expectedHeads: Schema.NullOr(AgentFlowHeads),
  input: Schema.String,
  operationId: OperationId,
  result: AgentFlowRevision,
  schemaVersion: Schema.Literal(1),
  /**
   * The slices the save produced, in whichever version wrote them. A record
   * left by an earlier Contingency embeds its screenshots, and replaying it
   * must answer with the draft it already saved rather than refusing to read
   * itself ([ADR 0033](../../../../docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).
   */
  slices: Schema.Array(StoredEvidenceSlice),
  sourceArtifacts: Schema.optional(SourceArtifacts),
  status: Schema.Literals(["pending", "completed"]),
});
type AgentFlowOperationRecord = typeof AgentFlowOperationRecord.Type;

const ApprovalArtifactRetention = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("delete-immediately") }),
  Schema.Struct({
    days: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    mode: Schema.Literal("retain-for-days"),
  }),
]);
type ApprovalArtifactRetention = typeof ApprovalArtifactRetention.Type;

const CatalogConfiguration = Schema.Struct({
  approvalArtifactRetention: ApprovalArtifactRetention,
  schemaVersion: Schema.Literal(1),
});

const AgentFlowDeletionRecord = Schema.Struct({
  expectedHeads: Schema.Struct({
    approvedRevisionId: AgentFlowHeads.fields.approvedRevisionId,
    archived: AgentFlowHeads.fields.archived,
    draftRevisionId: AgentFlowHeads.fields.draftRevisionId,
  }),
  input: Schema.String,
  operationId: OperationId,
  result: AgentFlowDeleteResult,
  schemaVersion: Schema.Literal(1),
  status: Schema.Literals(["pending", "completed"]),
});

/**
 * JSON with keys in a stable order, so one Evidence Slice always hashes to
 * one address regardless of how its object was assembled.
 */
const compareKeys = (
  [left]: readonly [string, Schema.Json],
  [right]: readonly [string, Schema.Json]
): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const JsonObject = Schema.Record(Schema.String, Schema.Json);

const normalizeJson = (input: Schema.Json): Schema.Json => {
  if (Array.isArray(input)) {
    return input.map(normalizeJson);
  }
  if (Schema.is(JsonObject)(input)) {
    const entries = Object.entries(input)
      .filter(([, entryValue]) => entryValue !== undefined)
      .toSorted(compareKeys);
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, normalizeJson(entryValue)])
    );
  }
  return input;
};

export const canonicalJson = <Value>(value: Value): string => {
  const serialized = Schema.decodeUnknownSync(Schema.String)(
    JSON.stringify(value)
  );
  const json = Schema.decodeUnknownSync(Schema.Json)(JSON.parse(serialized));
  return JSON.stringify(normalizeJson(json));
};

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
const encodeSliceV1 = Schema.encodeSync(StoredEvidenceSliceV1);

/**
 * Encode a slice under the exact schema that wrote it. Discriminating here
 * rather than leaning on union encoding keeps one stored slice at one address
 * whichever version it belongs to.
 */
const encodeStoredSlice = (slice: StoredEvidenceSlice) =>
  slice.schemaVersion === 1 ? encodeSliceV1(slice) : encodeSlice(slice);
const encodeManifest = Schema.encodeSync(AgentFlowManifest);
const encodeHeads = Schema.encodeSync(AgentFlowHeads);
const encodeOperation = Schema.encodeSync(AgentFlowOperationRecord);
const encodeHeadOperation = Schema.encodeSync(AgentFlowHeadOperationRecord);
const encodeSourceArtifacts = Schema.encodeSync(SourceArtifacts);
const encodeDeletionRecord = Schema.encodeSync(AgentFlowDeletionRecord);

const storeSourceArtifacts = (
  catalogRoot: string,
  artifacts: SourceArtifacts | undefined
): SourceArtifacts | undefined => {
  if (artifacts === undefined) {
    return undefined;
  }
  const relativeToCatalog = (file: string | undefined) => {
    if (file === undefined) {
      return;
    }
    return path.isAbsolute(file)
      ? path.relative(catalogRoot, file)
      : path.normalize(file);
  };
  return {
    retentionFile: relativeToCatalog(artifacts.retentionFile),
    traceFile: relativeToCatalog(artifacts.traceFile),
    videoFile: relativeToCatalog(artifacts.videoFile),
  };
};

const resolveSourceArtifacts = (
  catalogRoot: string,
  artifacts: SourceArtifacts
): SourceArtifacts => {
  const resolveFromCatalog = (file: string | undefined) =>
    file === undefined ? undefined : path.resolve(catalogRoot, file);
  return {
    retentionFile: resolveFromCatalog(artifacts.retentionFile),
    traceFile: resolveFromCatalog(artifacts.traceFile),
    videoFile: resolveFromCatalog(artifacts.videoFile),
  };
};

const operationRecord = (
  status: AgentFlowOperationRecord["status"],
  operationId: string,
  input: string,
  expectedHeads: AgentFlowHeads | null,
  result: AgentFlowRevision,
  slices: readonly StoredEvidenceSlice[],
  sourceArtifacts: SourceArtifacts | undefined
): AgentFlowOperationRecord => {
  const record = {
    expectedHeads,
    input,
    operationId: OperationId.make(operationId),
    result,
    schemaVersion: 1,
    slices,
    status,
  } satisfies AgentFlowOperationRecord;
  return sourceArtifacts === undefined
    ? record
    : { ...record, sourceArtifacts };
};

export const evidenceHash = (slice: StoredEvidenceSlice): EvidenceHash =>
  EvidenceHash.make(
    `sha256-${createHash("sha256")
      .update(canonicalJson(encodeStoredSlice(slice)))
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

const expectedHeadsMatch = (
  expected: AgentFlowExpectedHeads,
  current: AgentFlowHeads
): boolean =>
  expected.approvedRevisionId === current.approvedRevisionId &&
  expected.archived === current.archived &&
  expected.draftRevisionId === current.draftRevisionId;

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

/**
 * The verification of one exact revision. An authorization recorded for any
 * other revision is not this revision's authorization.
 */
const verificationOf = (
  heads: AgentFlowHeads,
  revisionId: AgentFlowRevisionId
): AgentFlowVerification | null =>
  heads.verification !== null && heads.verification.revisionId === revisionId
    ? heads.verification
    : null;

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
  const headOperations = new Map<
    string,
    { readonly input: string; readonly result: AgentFlowRevision }
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
  /**
   * Head mutations keep their own record namespace: a draft save and an
   * approval are different effects, so one operation id used for both is a
   * conflict in each namespace rather than a silent replay across them.
   */
  const headOperationFile = (catalogRoot: string, operationId: string) =>
    path.join(
      operationsDirectory(catalogRoot),
      `head-sha256-${createHash("sha256").update(operationId).digest("hex")}.json`
    );
  const deletionOperationFile = (catalogRoot: string, operationId: string) =>
    path.join(
      operationsDirectory(catalogRoot),
      `delete-sha256-${createHash("sha256").update(operationId).digest("hex")}.json`
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
          try: () => JSON.parse(contents),
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
      const expectedBasedOn =
        persisted.expectedHeads?.draftRevisionId ??
        persisted.expectedHeads?.approvedRevisionId ??
        null;
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
              verification: null,
            }
          : {
              ...persisted.expectedHeads,
              draftRevisionId: manifest.revisionId,
              updatedAt: manifest.createdAt,
              verification: null,
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

  /**
   * The address of a slice exactly as it is stored, computed from the file's
   * own JSON. A package written under an earlier schema version keeps the
   * address its manifest names rather than being rehashed as if it had been
   * written today.
   */
  const persistedEvidenceHash = (
    catalogRoot: string,
    file: string
  ): Effect.Effect<EvidenceHash, AgentFlowCatalogError> =>
    ensureCatalogPath(catalogRoot, file, "Evidence Slice").pipe(
      Effect.andThen(
        fileSystem
          .readFileString(file)
          .pipe(Effect.mapError(ioError("Could not read an Evidence Slice")))
      ),
      Effect.flatMap((contents) =>
        Effect.try({
          catch: () =>
            catalogError("agent_catalog_invalid", `${file} is not valid JSON.`),
          try: () =>
            EvidenceHash.make(
              `sha256-${createHash("sha256")
                .update(canonicalJson(JSON.parse(contents)))
                .digest("hex")}`
            ),
        })
      )
    );

  /** Every slice screenshot must resolve to bytes the package already holds. */
  const verifyScreenshots = (
    catalogRoot: string,
    directory: string,
    slice: StoredEvidenceSlice,
    index: number
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    // A slice written before screenshots were stored once embeds them, so
    // there is nothing beside it to resolve.
    Effect.forEach(
      slice.schemaVersion === 1 ? [] : slice.screenshots,
      (screenshot) =>
        Effect.gen(function* verifyOneScreenshot() {
          const file = path.join(directory, screenshot.path);
          yield* ensureCatalogPath(catalogRoot, file, "a stored screenshot");
          const present = yield* fileSystem
            .exists(file)
            .pipe(Effect.mapError(ioError("Could not inspect a screenshot")));
          if (!present) {
            return yield* Effect.fail(
              catalogError(
                "agent_catalog_invalid",
                `Evidence Slice ${index} references screenshot ${screenshot.contentHash}, whose bytes were not supplied.`
              )
            );
          }
        }),
      { discard: true }
    );

  /**
   * Store the bytes the slices reference, once each, before anything names
   * them. Content addressing makes the write idempotent, so a retry after a
   * crash finds them already there rather than needing them again.
   */
  const writeScreenshots = (
    catalogRoot: string,
    agentFlowId: AgentFlowId,
    slices: readonly StoredEvidenceSlice[],
    contents: readonly TeachingScreenshotContent[] = []
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    Effect.gen(function* storeScreenshotBytes() {
      const referenced = new Map(
        slices.flatMap((slice) =>
          (slice.schemaVersion === 1 ? [] : slice.screenshots).map(
            (screenshot) => [screenshot.contentHash, screenshot.path]
          )
        )
      );
      if (referenced.size === 0) {
        return;
      }
      const directory = flowDirectory(catalogRoot, agentFlowId);
      const screenshotsDirectory = path.join(directory, SCREENSHOTS_DIRECTORY);
      yield* ensureCatalogPath(
        catalogRoot,
        screenshotsDirectory,
        "Agent Flow screenshots"
      );
      yield* fileSystem
        .makeDirectory(screenshotsDirectory, { recursive: true })
        .pipe(
          Effect.mapError(ioError("Could not create the screenshot store"))
        );
      const supplied = new Map(
        contents.map((content) => [content.contentHash, content])
      );
      yield* Effect.forEach(
        [...referenced],
        ([contentHash, relative]) =>
          Effect.gen(function* storeOneScreenshot() {
            const file = path.join(directory, relative);
            yield* ensureCatalogPath(catalogRoot, file, "a stored screenshot");
            const present = yield* fileSystem
              .exists(file)
              .pipe(Effect.mapError(ioError("Could not inspect a screenshot")));
            if (present) {
              return;
            }
            const content = supplied.get(contentHash);
            if (content === undefined) {
              return yield* Effect.fail(
                catalogError(
                  "agent_catalog_invalid",
                  `Screenshot ${contentHash} is referenced by an Agent Step but its bytes were not supplied.`
                )
              );
            }
            const temporary = `${file}.${randomUUID()}.tmp`;
            yield* fileSystem
              .writeFile(temporary, Buffer.from(content.image, "base64"))
              .pipe(
                Effect.andThen(fileSystem.rename(temporary, file)),
                Effect.mapError(ioError("Could not write a screenshot"))
              );
          }),
        { discard: true }
      );
    });

  const writeDraftArtifacts = (
    catalogRoot: string,
    manifest: AgentFlowManifest,
    slices: readonly StoredEvidenceSlice[],
    sourceArtifacts?: SourceArtifacts
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
        yield* verifyScreenshots(catalogRoot, directory, slice, index);
        const file = path.join(directory, relative);
        const present = yield* fileSystem
          .exists(file)
          .pipe(Effect.mapError(ioError("Could not inspect evidence")));
        if (present) {
          const existing = yield* persistedEvidenceHash(catalogRoot, file);
          if (existing !== hash) {
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
            JSON.stringify(encodeStoredSlice(slice), null, 2),
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
      if (sourceArtifacts !== undefined) {
        yield* writeJson(
          path.join(revisionPath, SOURCE_ARTIFACTS_FILE),
          JSON.stringify(encodeSourceArtifacts(sourceArtifacts), null, 2),
          "the Teaching artifact record"
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
            yield* writeDraftArtifacts(
              catalogRoot,
              manifest,
              persisted.slices,
              persisted.sourceArtifacts
            );
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
          yield* writeDraftArtifacts(
            catalogRoot,
            manifest,
            persisted.slices,
            persisted.sourceArtifacts
          );
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
      const ids: AgentFlowId[] = [];
      for (const entry of entries) {
        if (Schema.is(AgentFlowId)(entry)) {
          ids.push(AgentFlowId.make(entry));
        }
      }
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

  /**
   * Recover the demonstrated span of a Step stored before Contingency kept
   * one. The Evidence Slice the Step already names was cut from exactly that
   * span, so its first and last captured actions are its boundaries — an
   * explicit, non-destructive migration of what the Catalog Root holds
   * (ADR 0033).
   */
  const stepWithSpan = (
    catalogRoot: string,
    id: AgentFlowId,
    step: StoredAgentStepV1 | AgentStep
  ): Effect.Effect<AgentStep, AgentFlowCatalogError> => {
    if (step.firstActionId !== undefined && step.lastActionId !== undefined) {
      return Effect.succeed({
        ...step,
        firstActionId: step.firstActionId,
        lastActionId: step.lastActionId,
      });
    }
    return readJson(
      StoredEvidenceSlice,
      path.join(flowDirectory(catalogRoot, id), step.evidence.path),
      "Evidence Slice",
      catalogRoot
    ).pipe(
      Effect.flatMap((slice) => {
        const [first] = slice.actions;
        const last = slice.actions.at(-1);
        if (first === undefined || last === undefined) {
          return Effect.fail(
            catalogError(
              "agent_catalog_invalid",
              `Agent Step ${step.index + 1} of ${id} names no demonstrated actions, so its span cannot be recovered.`
            )
          );
        }
        return Effect.succeed({
          ...step,
          firstActionId: first.id,
          lastActionId: last.id,
        });
      })
    );
  };

  const readManifest = (
    catalogRoot: string,
    id: AgentFlowId,
    revisionId: AgentFlowRevisionId
  ): Effect.Effect<AgentFlowManifest, AgentFlowCatalogError> =>
    readJson(
      StoredAgentFlowManifest,
      path.join(revisionDirectory(catalogRoot, id, revisionId), MANIFEST_FILE),
      "Agent Flow manifest",
      catalogRoot
    ).pipe(
      Effect.flatMap((stored) =>
        Effect.all(
          stored.steps.map((step) => stepWithSpan(catalogRoot, id, step))
        ).pipe(
          Effect.map((steps) => ({
            ...stored,
            schemaVersion: 2,
            steps,
          }))
        )
      )
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
            verification: null,
          };
      const expectedHeads = headsExist ? existing : null;
      const currentBaseRevisionId =
        existing.draftRevisionId ?? existing.approvedRevisionId;
      if (currentBaseRevisionId !== input.basedOnRevisionId) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            currentBaseRevisionId === null
              ? `Agent Flow ${agentFlowId} has no revision; save a new draft with basedOnRevisionId null.`
              : `Agent Flow ${agentFlowId} current head is ${currentBaseRevisionId}, not ${String(input.basedOnRevisionId)}. Reread it before proposing another revision.`
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
            firstActionId: step.firstActionId,
            index,
            lastActionId: step.lastActionId,
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
        schemaVersion: 2,
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
        // A changed draft is a different draft. The previous authorization
        // covered one exact revision and does not travel to this one.
        verification: null,
      };
      const saved = revision(catalogRoot, heads, manifest);
      const sourceArtifacts = storeSourceArtifacts(
        catalogRoot,
        input.sourceArtifacts
      );
      const pending =
        operationKey === undefined
          ? null
          : operationRecord(
              "pending",
              operationKey,
              requestInput,
              expectedHeads,
              saved,
              input.slices,
              sourceArtifacts
            );
      yield* writeScreenshots(
        catalogRoot,
        agentFlowId,
        input.slices,
        input.screenshots
      );
      yield* writePendingOperation(catalogRoot, pending);
      yield* writeDraftArtifacts(
        catalogRoot,
        manifest,
        input.slices,
        sourceArtifacts
      );
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

  /** What one head mutation decided to write. */
  interface HeadMutation {
    readonly heads: AgentFlowHeads;
    readonly manifest: AgentFlowManifest;
    readonly writeManifest?: boolean;
  }

  /**
   * Apply one head mutation under the catalog lock, exactly once per operation
   * id. The record is written before the heads move, so a transport retry that
   * lands after a crash answers with the original result rather than deciding
   * the transition again.
   */
  const mutateHeadsUnlocked = Effect.fn("AgentFlowCatalog.mutateHeads")(
    function* applyHeadMutation(
      catalogRoot: string,
      agentFlowId: AgentFlowId,
      operationId: string,
      requestInput: string,
      decide: (
        heads: AgentFlowHeads
      ) => Effect.Effect<HeadMutation, AgentFlowCatalogError>
    ) {
      const cacheKey = operationCacheKey(catalogRoot, operationId);
      const cached = headOperations.get(cacheKey);
      if (cached !== undefined) {
        return cached.input === requestInput
          ? cached.result
          : yield* Effect.fail(
              catalogError(
                "agent_flow_conflict",
                `Operation ${operationId} was already used for a different Agent Flow mutation.`
              )
            );
      }
      const recordFile = headOperationFile(catalogRoot, operationId);
      const recordExists = yield* fileSystem
        .exists(recordFile)
        .pipe(
          Effect.mapError(ioError("Could not inspect the Agent Flow operation"))
        );
      const headsFile = path.join(
        flowDirectory(catalogRoot, agentFlowId),
        HEADS_FILE
      );
      const headsExist = yield* fileSystem
        .exists(headsFile)
        .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
      if (!headsExist) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_not_found",
            `Agent Flow ${agentFlowId} is not in the catalog at ${catalogRoot}.`
          )
        );
      }
      const current = yield* readHeads(catalogRoot, agentFlowId);
      if (recordExists) {
        const persisted = yield* readJson(
          AgentFlowHeadOperationRecord,
          recordFile,
          "Agent Flow operation record",
          catalogRoot
        );
        if (persisted.input !== requestInput) {
          return yield* Effect.fail(
            catalogError(
              "agent_flow_conflict",
              `Operation ${operationId} was already used for a different Agent Flow mutation.`
            )
          );
        }
        // Finish an interrupted write only while the heads still stand where
        // it left them. A world that moved on keeps its own state and the
        // retry answers with the result the id already produced.
        if (sameHeads(current, persisted.expectedHeads)) {
          if (persisted.writeManifest) {
            yield* writeJson(
              path.join(
                revisionDirectory(
                  catalogRoot,
                  agentFlowId,
                  persisted.result.manifest.revisionId
                ),
                MANIFEST_FILE
              ),
              JSON.stringify(
                encodeManifest(persisted.result.manifest),
                null,
                2
              ),
              "the Agent Flow manifest"
            );
          }
          yield* writeJson(
            headsFile,
            JSON.stringify(encodeHeads(persisted.result.heads), null, 2),
            "the Agent Flow record"
          );
        }
        headOperations.set(cacheKey, {
          input: requestInput,
          result: persisted.result,
        });
        return persisted.result;
      }
      const decided = yield* decide(current);
      const result = revision(catalogRoot, decided.heads, decided.manifest);
      yield* ensureCatalogPath(
        catalogRoot,
        operationsDirectory(catalogRoot),
        "Agent Flow operation records"
      );
      yield* fileSystem
        .makeDirectory(operationsDirectory(catalogRoot), { recursive: true })
        .pipe(Effect.mapError(ioError("Could not create operation records")));
      yield* writeJson(
        recordFile,
        JSON.stringify(
          encodeHeadOperation({
            expectedHeads: current,
            input: requestInput,
            operationId: OperationId.make(operationId),
            result,
            schemaVersion: 1,
            writeManifest: decided.writeManifest ?? true,
          }),
          null,
          2
        ),
        "the Agent Flow operation record"
      );
      if (decided.writeManifest ?? true) {
        yield* writeJson(
          path.join(
            revisionDirectory(
              catalogRoot,
              agentFlowId,
              decided.manifest.revisionId
            ),
            MANIFEST_FILE
          ),
          JSON.stringify(encodeManifest(decided.manifest), null, 2),
          "the Agent Flow manifest"
        );
      }
      yield* writeJson(
        headsFile,
        JSON.stringify(encodeHeads(decided.heads), null, 2),
        "the Agent Flow record"
      );
      headOperations.set(cacheKey, { input: requestInput, result });
      return result;
    }
  );

  const mutateHeads = <Extra extends object>(
    kind: string,
    input: RevisionOperationInput,
    extra: Extra,
    decide: (
      heads: AgentFlowHeads,
      at: string
    ) => Effect.Effect<HeadMutation, AgentFlowCatalogError>
  ) =>
    writes.withPermit(
      Effect.gen(function* mutateHeadsWithCatalogLock() {
        const catalogRoot = yield* Ref.get(root);
        yield* ensureCatalogPath(
          catalogRoot,
          flowsDirectory(catalogRoot),
          "Agent Flow Catalog"
        );
        const requestInput = canonicalJson({
          agentFlowId: input.agentFlowId,
          kind,
          revisionId: input.revisionId,
          ...extra,
        });
        return yield* withCatalogLock(
          catalogRoot,
          mutateHeadsUnlocked(
            catalogRoot,
            input.agentFlowId,
            String(input.operationId),
            requestInput,
            (heads) => decide(heads, now().toISOString())
          )
        );
      })
    );

  /** The draft under review, refused when the caller named a stale revision. */
  const requireDraftHead = (
    catalogRoot: string,
    heads: AgentFlowHeads,
    revisionId: AgentFlowRevisionId
  ): Effect.Effect<AgentFlowManifest, AgentFlowCatalogError> =>
    heads.draftRevisionId === revisionId
      ? readManifest(catalogRoot, heads.id, revisionId)
      : Effect.fail(
          catalogError(
            "agent_flow_conflict",
            heads.draftRevisionId === null
              ? `Agent Flow ${heads.id} has no draft revision to act on.`
              : `Agent Flow ${heads.id} draft head is ${heads.draftRevisionId}, not ${revisionId}. Reread the draft before acting on it.`
          )
        );

  const approvalRetention = (
    catalogRoot: string
  ): Effect.Effect<ApprovalArtifactRetention, AgentFlowCatalogError> =>
    Effect.gen(function* readApprovalRetention() {
      const configurationFile = path.join(catalogRoot, CATALOG_CONFIG_FILE);
      const exists = yield* fileSystem
        .exists(configurationFile)
        .pipe(
          Effect.mapError(ioError("Could not inspect Catalog retention policy"))
        );
      if (!exists) {
        return { mode: "delete-immediately" };
      }
      const configured = yield* Effect.result(
        readJson(
          CatalogConfiguration,
          configurationFile,
          "Agent Flow Catalog configuration",
          catalogRoot
        )
      );
      if (Result.isFailure(configured)) {
        yield* Effect.logWarning(
          "Catalog retention configuration is invalid; sensitive Teaching artifacts will use immediate deletion.",
          configured.failure
        );
        return { mode: "delete-immediately" };
      }
      return configured.success.approvalArtifactRetention;
    });

  const readSourceArtifacts = (
    catalogRoot: string,
    agentFlowId: AgentFlowId,
    revisionId: AgentFlowRevisionId
  ): Effect.Effect<SourceArtifacts | null, AgentFlowCatalogError> => {
    const file = path.join(
      revisionDirectory(catalogRoot, agentFlowId, revisionId),
      SOURCE_ARTIFACTS_FILE
    );
    return fileSystem.exists(file).pipe(
      Effect.mapError(ioError("Could not inspect Teaching artifacts")),
      Effect.flatMap((exists) =>
        exists
          ? readJson(
              SourceArtifacts,
              file,
              "Teaching artifact record",
              catalogRoot
            ).pipe(
              Effect.map((artifacts) =>
                resolveSourceArtifacts(catalogRoot, artifacts)
              )
            )
          : Effect.succeed(null)
      )
    );
  };

  const writeRetainedSourceArtifacts = (
    catalogRoot: string,
    agentFlowId: AgentFlowId,
    revisionId: AgentFlowRevisionId,
    retentionFile: string | undefined
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    writeJson(
      path.join(
        revisionDirectory(catalogRoot, agentFlowId, revisionId),
        SOURCE_ARTIFACTS_FILE
      ),
      JSON.stringify(
        encodeSourceArtifacts(
          storeSourceArtifacts(catalogRoot, { retentionFile }) ?? {}
        ),
        null,
        2
      ),
      "the Teaching artifact record"
    );

  /**
   * Sensitive artifact paths originate in the Contingency-owned Teaching
   * session. Revalidate that every file is a sibling of its retention record
   * before deleting or scheduling it, so a modified package cannot target an
   * unrelated path.
   */
  const validateSourceArtifacts = (
    artifacts: SourceArtifacts
  ): Effect.Effect<readonly string[], AgentFlowCatalogError> =>
    Effect.gen(function* validateArtifactPaths() {
      const files = [
        artifacts.retentionFile,
        artifacts.traceFile,
        artifacts.videoFile,
      ].filter((file): file is string => file !== undefined);
      if (files.length === 0) {
        return [];
      }
      const artifactDirectory = path.dirname(
        artifacts.retentionFile ?? files[0] ?? ""
      );
      const safe = yield* Effect.forEach(
        files,
        (file) => isPhysicallyWithinCatalogRoot(artifactDirectory, file),
        { discard: false }
      );
      if (safe.every(Boolean)) {
        return files;
      }
      return yield* Effect.fail(
        catalogError(
          "agent_catalog_invalid",
          "A Teaching artifact resolves outside its retention directory."
        )
      );
    });

  const applyApprovalRetention = (
    approved: AgentFlowRevision
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    Effect.gen(function* retainApprovedArtifacts() {
      const artifacts = yield* readSourceArtifacts(
        approved.catalogRoot,
        approved.manifest.agentFlowId,
        approved.manifest.revisionId
      );
      if (artifacts === null) {
        return;
      }
      const files = yield* validateSourceArtifacts(artifacts);
      const policy = yield* approvalRetention(approved.catalogRoot);
      if (policy.mode === "delete-immediately") {
        if (artifacts.retentionFile !== undefined) {
          yield* fileSystem
            .writeFileString(
              artifacts.retentionFile,
              `${JSON.stringify(
                {
                  approvedAt: now().toISOString(),
                  retention: "delete-on-approval",
                },
                null,
                2
              )}\n`
            )
            .pipe(
              Effect.mapError(
                ioError("Could not update Teaching retention metadata")
              )
            );
        }
        yield* Effect.forEach(
          files.filter((file) => file !== artifacts.retentionFile),
          (file) =>
            fileSystem
              .remove(file, { force: true })
              .pipe(
                Effect.mapError(ioError("Could not remove a Teaching artifact"))
              ),
          { discard: true }
        );
        yield* writeRetainedSourceArtifacts(
          approved.catalogRoot,
          approved.manifest.agentFlowId,
          approved.manifest.revisionId,
          artifacts.retentionFile
        );
        return;
      }
      if (artifacts.retentionFile === undefined) {
        return yield* Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            "A retained Teaching artifact package has no retention record."
          )
        );
      }
      const current = yield* fileSystem
        .readFileString(artifacts.retentionFile)
        .pipe(
          Effect.mapError(ioError("Could not read Teaching retention metadata"))
        );
      const metadata = yield* Effect.try({
        catch: () =>
          catalogError(
            "agent_catalog_invalid",
            "Teaching retention metadata is not valid JSON."
          ),
        try: () => {
          const decoded = Schema.decodeUnknownOption(RetentionMetadata)(
            JSON.parse(current)
          );
          return Option.getOrElse(decoded, () => ({}));
        },
      });
      const deleteAfter = new Date(
        now().getTime() + policy.days * 86_400_000
      ).toISOString();
      yield* fileSystem
        .writeFileString(
          artifacts.retentionFile,
          `${JSON.stringify(
            {
              ...metadata,
              deleteAfter,
              retention: "retain-for-days",
            },
            null,
            2
          )}\n`
        )
        .pipe(
          Effect.mapError(
            ioError("Could not update Teaching retention metadata")
          )
        );
    });

  /**
   * A Catalog startup is the durable retention worker: schedules survive
   * process exits because their deadline and artifact paths live on disk.
   */
  const removeExpiredApprovalArtifacts = (
    catalogRoot: string
  ): Effect.Effect<void, AgentFlowCatalogError> =>
    Effect.gen(function* removeExpiredArtifacts() {
      const agentFlowIds = yield* listFlowIds(catalogRoot);
      yield* Effect.forEach(
        agentFlowIds,
        (agentFlowId) =>
          Effect.gen(function* removeExpiredFlowArtifacts() {
            const revisions = path.join(
              flowDirectory(catalogRoot, agentFlowId),
              REVISIONS_DIRECTORY
            );
            const revisionsExist = yield* fileSystem
              .exists(revisions)
              .pipe(
                Effect.mapError(
                  ioError(
                    "Could not inspect Agent Flow revisions for retention"
                  )
                )
              );
            if (!revisionsExist) {
              return;
            }
            const revisionIds = yield* fileSystem
              .readDirectory(revisions)
              .pipe(
                Effect.mapError(
                  ioError("Could not list Agent Flow revisions for retention")
                )
              );
            yield* Effect.forEach(
              revisionIds,
              (revisionId) =>
                Effect.gen(function* removeExpiredRevisionArtifacts() {
                  const sourceFile = path.join(
                    revisions,
                    revisionId,
                    SOURCE_ARTIFACTS_FILE
                  );
                  const sourceExists = yield* fileSystem
                    .exists(sourceFile)
                    .pipe(
                      Effect.mapError(
                        ioError("Could not inspect Teaching artifact metadata")
                      )
                    );
                  if (!sourceExists) {
                    return;
                  }
                  const storedArtifacts = yield* readJson(
                    SourceArtifacts,
                    sourceFile,
                    "Teaching artifact record",
                    catalogRoot
                  );
                  const artifacts = resolveSourceArtifacts(
                    catalogRoot,
                    storedArtifacts
                  );
                  if (artifacts.retentionFile === undefined) {
                    return;
                  }
                  const retentionExists = yield* fileSystem
                    .exists(artifacts.retentionFile)
                    .pipe(
                      Effect.mapError(
                        ioError("Could not inspect Teaching retention metadata")
                      )
                    );
                  if (!retentionExists) {
                    return;
                  }
                  const metadata = yield* fileSystem
                    .readFileString(artifacts.retentionFile)
                    .pipe(
                      Effect.mapError(
                        ioError("Could not read Teaching retention metadata")
                      )
                    );
                  const deadline = retentionDeadline(metadata);
                  if (deadline === null || deadline > now().getTime()) {
                    return;
                  }
                  const files = yield* validateSourceArtifacts(artifacts);
                  yield* Effect.forEach(
                    files.filter((file) => file !== artifacts.retentionFile),
                    (file) =>
                      fileSystem
                        .remove(file, { force: true })
                        .pipe(
                          Effect.mapError(
                            ioError(
                              "Could not remove an expired Teaching artifact"
                            )
                          )
                        ),
                    { discard: true }
                  );
                  yield* fileSystem
                    .writeFileString(
                      artifacts.retentionFile,
                      `${JSON.stringify(
                        {
                          deleteAfter: new Date(deadline).toISOString(),
                          expiredAt: now().toISOString(),
                          retention: "expired",
                        },
                        null,
                        2
                      )}\n`
                    )
                    .pipe(
                      Effect.mapError(
                        ioError("Could not update Teaching retention metadata")
                      )
                    );
                  yield* writeRetainedSourceArtifacts(
                    catalogRoot,
                    AgentFlowId.make(agentFlowId),
                    AgentFlowRevisionId.make(revisionId),
                    artifacts.retentionFile
                  );
                }),
              { discard: true }
            );
          }),
        { discard: true }
      );
    });

  const deletePermanentlyUnlocked = Effect.fn(
    "AgentFlowCatalog.deletePermanently"
  )(function* deleteAgentFlow(
    catalogRoot: string,
    input: DeleteAgentFlowInput
  ) {
    if (input.confirmation !== "permanently-delete") {
      return yield* Effect.fail(
        catalogError(
          "agent_catalog_invalid",
          "Permanent deletion requires direct confirmation in Agent View."
        )
      );
    }
    const operationId = String(input.operationId);
    const requestInput = canonicalJson({
      agentFlowId: input.agentFlowId,
      confirmation: input.confirmation,
      expectedHeads: input.expectedHeads,
    });
    const recordFile = deletionOperationFile(catalogRoot, operationId);
    const recordExists = yield* fileSystem
      .exists(recordFile)
      .pipe(
        Effect.mapError(ioError("Could not inspect the deletion operation"))
      );
    if (recordExists) {
      const record = yield* readJson(
        AgentFlowDeletionRecord,
        recordFile,
        "Agent Flow deletion record",
        catalogRoot
      );
      if (record.input !== requestInput) {
        return yield* Effect.fail(
          catalogError(
            "agent_flow_conflict",
            `Operation ${operationId} was already used for a different Agent Flow deletion.`
          )
        );
      }
      if (record.status === "pending") {
        yield* fileSystem
          .remove(flowDirectory(catalogRoot, input.agentFlowId), {
            force: true,
            recursive: true,
          })
          .pipe(
            Effect.mapError(
              ioError("Could not finish permanently deleting the Agent Flow")
            )
          );
        yield* writeJson(
          recordFile,
          JSON.stringify(
            encodeDeletionRecord({ ...record, status: "completed" }),
            null,
            2
          ),
          "the Agent Flow deletion record"
        );
      }
      return record.result;
    }

    const directory = flowDirectory(catalogRoot, input.agentFlowId);
    const headsFile = path.join(directory, HEADS_FILE);
    const exists = yield* fileSystem
      .exists(headsFile)
      .pipe(Effect.mapError(ioError("Could not inspect the Agent Flow")));
    if (!exists) {
      return yield* Effect.fail(
        catalogError(
          "agent_flow_not_found",
          `Agent Flow ${input.agentFlowId} is not in the catalog at ${catalogRoot}.`
        )
      );
    }
    const heads = yield* readHeads(catalogRoot, input.agentFlowId);
    if (!expectedHeadsMatch(input.expectedHeads, heads)) {
      return yield* Effect.fail(
        catalogError(
          "agent_flow_conflict",
          `Agent Flow ${input.agentFlowId} changed before it could be permanently deleted. Reread it before asking the user again.`
        )
      );
    }
    const result: AgentFlowDeleteResult = {
      agentFlowId: input.agentFlowId,
      deleted: true,
    };
    yield* fileSystem
      .makeDirectory(operationsDirectory(catalogRoot), { recursive: true })
      .pipe(Effect.mapError(ioError("Could not create operation records")));
    yield* writeJson(
      recordFile,
      JSON.stringify(
        encodeDeletionRecord({
          expectedHeads: input.expectedHeads,
          input: requestInput,
          operationId: OperationId.make(operationId),
          result,
          schemaVersion: 1,
          status: "pending",
        }),
        null,
        2
      ),
      "the Agent Flow deletion record"
    );
    yield* ensureCatalogPath(catalogRoot, directory, "Agent Flow package");
    yield* fileSystem
      .remove(directory, { recursive: true })
      .pipe(
        Effect.mapError(ioError("Could not permanently delete the Agent Flow"))
      );
    yield* writeJson(
      recordFile,
      JSON.stringify(
        encodeDeletionRecord({
          expectedHeads: input.expectedHeads,
          input: requestInput,
          operationId: OperationId.make(operationId),
          result,
          schemaVersion: 1,
          status: "completed",
        }),
        null,
        2
      ),
      "the Agent Flow deletion record"
    );
    return result;
  });

  const service: AgentFlowCatalogService = {
    approve: (input) =>
      mutateHeads("approve", input, {}, (heads, at) =>
        Effect.gen(function* approveRevision() {
          const catalogRoot = yield* Ref.get(root);
          const manifest = yield* requireDraftHead(
            catalogRoot,
            heads,
            input.revisionId
          );
          const verification = verificationOf(heads, input.revisionId);
          if (verification === null || verification.status !== "passed") {
            return yield* Effect.fail(
              catalogError(
                "agent_flow_conflict",
                `Agent Flow ${heads.id} revision ${input.revisionId} has no successful Verification Run, so it cannot be approved.`
              )
            );
          }
          return {
            heads: {
              ...heads,
              approvedRevisionId: input.revisionId,
              draftRevisionId: null,
              updatedAt: at,
            },
            manifest: { ...manifest, status: "approved" },
          };
        })
      ).pipe(
        Effect.tap((approved) =>
          applyApprovalRetention(approved).pipe(
            // Effect error recovery is callback-based by design.
            // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then
            Effect.catch((retentionError) =>
              Effect.logWarning(
                "Approval committed, but Teaching artifact retention could not be applied.",
                retentionError
              )
            )
          )
        )
      ),
    authorizeVerification: (input) =>
      mutateHeads(
        "verification.authorize",
        input,
        { startingUrl: input.startingUrl ?? null },
        (heads, at) =>
          Effect.gen(function* authorizeVerificationRun() {
            const catalogRoot = yield* Ref.get(root);
            const manifest = yield* requireDraftHead(
              catalogRoot,
              heads,
              input.revisionId
            );
            const verification = verificationOf(heads, input.revisionId);
            if (verification?.status === "running") {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  `A Verification Run of ${input.revisionId} is already in progress.`
                )
              );
            }
            if (verification?.status === "passed") {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  `Revision ${input.revisionId} already passed verification and is waiting for your approval.`
                )
              );
            }
            return {
              heads: {
                ...heads,
                updatedAt: at,
                verification: {
                  assessments: [],
                  authorizationId: `auth-${randomUUID()}`,
                  authorizedAt: at,
                  completedAt: null,
                  revisionId: input.revisionId,
                  sessionId: null,
                  startedAt: null,
                  startingUrl: input.startingUrl ?? null,
                  status: "authorized",
                  summary: null,
                },
              },
              manifest,
              writeManifest: false,
            };
          })
      ),
    completeVerification: (input) =>
      mutateHeads(
        "verification.complete",
        input,
        {
          assessments: input.assessments,
          outcome: input.outcome,
          summary: input.summary,
        },
        (heads, at) =>
          Effect.gen(function* completeVerificationRun() {
            const catalogRoot = yield* Ref.get(root);
            const manifest = yield* requireDraftHead(
              catalogRoot,
              heads,
              input.revisionId
            );
            const verification = verificationOf(heads, input.revisionId);
            if (verification === null || verification.status !== "running") {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  `No Verification Run of ${input.revisionId} is in progress.`
                )
              );
            }
            const ordered = input.assessments.every(
              (assessment, index) => assessment.stepIndex === index
            );
            const completePass =
              input.assessments.length === manifest.steps.length &&
              input.assessments.every(
                (assessment) => assessment.outcome === "working"
              );
            const terminalFailure =
              input.assessments.length > 0 &&
              input.assessments.length <= manifest.steps.length &&
              input.assessments.at(-1)?.outcome !== "working" &&
              input.assessments
                .slice(0, -1)
                .every((assessment) => assessment.outcome === "working");
            const outcomeMatches =
              input.outcome === "passed" ? completePass : terminalFailure;
            if (!(ordered && outcomeMatches)) {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  input.outcome === "passed"
                    ? "A passed Verification Run requires one working assessment for every ordered Agent Step."
                    : "A failed Verification Run requires an ordered working prefix followed by one terminal non-working assessment."
                )
              );
            }
            return {
              heads: {
                ...heads,
                updatedAt: at,
                verification: {
                  ...verification,
                  assessments: input.assessments,
                  completedAt: at,
                  status: input.outcome,
                  summary: input.summary,
                },
              },
              manifest,
              writeManifest: false,
            };
          })
      ),
    deletePermanently: (input) =>
      writes.withPermit(
        Effect.gen(function* deleteWithCatalogLock() {
          const catalogRoot = yield* Ref.get(root);
          return yield* withCatalogLock(
            catalogRoot,
            deletePermanentlyUnlocked(catalogRoot, input)
          );
        })
      ),
    evidence: (agentFlowId, revisionId) =>
      get(agentFlowId, revisionId).pipe(
        Effect.flatMap((found) =>
          Effect.all(
            found.manifest.steps.map((step) =>
              readJson(
                StoredEvidenceSlice,
                path.join(
                  flowDirectory(found.catalogRoot, found.manifest.agentFlowId),
                  step.evidence.path
                ),
                "Evidence Slice",
                found.catalogRoot
              )
            )
          )
        )
      ),
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
    setArchived: (input) => {
      const revisionId =
        input.expectedHeads.draftRevisionId ??
        input.expectedHeads.approvedRevisionId;
      if (revisionId === null) {
        return Effect.fail(
          catalogError(
            "agent_catalog_invalid",
            `Agent Flow ${input.agentFlowId} has no head to archive.`
          )
        );
      }
      return mutateHeads(
        "archive",
        {
          agentFlowId: input.agentFlowId,
          operationId: input.operationId,
          revisionId,
        },
        { archived: input.archived, expectedHeads: input.expectedHeads },
        (heads, at) =>
          Effect.gen(function* archiveAgentFlow() {
            if (!expectedHeadsMatch(input.expectedHeads, heads)) {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  `Agent Flow ${input.agentFlowId} changed before its archive state could be updated. Reread it before retrying.`
                )
              );
            }
            const catalogRoot = yield* Ref.get(root);
            const manifest = yield* readManifest(
              catalogRoot,
              input.agentFlowId,
              revisionId
            );
            return {
              heads: { ...heads, archived: input.archived, updatedAt: at },
              manifest,
              writeManifest: false,
            };
          })
      );
    },
    startVerification: (input) =>
      mutateHeads(
        "verification.start",
        input,
        { sessionId: input.sessionId },
        (heads, at) =>
          Effect.gen(function* startVerificationRun() {
            const catalogRoot = yield* Ref.get(root);
            const manifest = yield* requireDraftHead(
              catalogRoot,
              heads,
              input.revisionId
            );
            const verification = verificationOf(heads, input.revisionId);
            if (verification === null || verification.status !== "authorized") {
              return yield* Effect.fail(
                catalogError(
                  "agent_flow_conflict",
                  `Revision ${input.revisionId} has no unspent Verification Run authorization. Ask the user to authorize verification in Agent View.`
                )
              );
            }
            return {
              heads: {
                ...heads,
                updatedAt: at,
                verification: {
                  ...verification,
                  sessionId: input.sessionId,
                  startedAt: at,
                  status: "running",
                },
              },
              manifest,
              writeManifest: false,
            };
          })
      ),
  };
  const catalogRoot = yield* Ref.get(root);
  yield* removeExpiredApprovalArtifacts(catalogRoot).pipe(
    // Effect error recovery is callback-based by design.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then
    Effect.catch((retentionError) =>
      Effect.logWarning(
        "Expired Teaching artifacts could not be removed.",
        retentionError
      )
    )
  );
  return service;
});

export const makeAgentFlowCatalogLayer = (
  options: AgentFlowCatalogOptions
): Layer.Layer<AgentFlowCatalogService, never, FileSystem.FileSystem> =>
  Layer.effect(AgentFlowCatalog, makeCatalog(options));
