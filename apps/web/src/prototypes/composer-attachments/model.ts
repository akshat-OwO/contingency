import type { ScanMode } from "@contingency/protocol";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";

/**
 * PROTOTYPE ONLY. A mocked checkout recording and a local condition model for
 * comparing Teaching comment composer directions. Nothing here talks to a
 * Browser Session, the server, or MCP.
 */

export type ApproachId = "drop" | "plus" | "point" | "suggest";

/** An element the inspector attached, as production describes it. */
export interface ElementRef {
  readonly description: string;
  readonly id: string;
}

/** Stand-ins for what inspect would attach from the mock page. */
export const mockElements: readonly ElementRef[] = [
  { description: "heading “Thanks, your order is on its way.”", id: "e-1" },
  { description: "text “Order received”", id: "e-2" },
];

/** A taught scan, as production's composer records one. */
export interface ScanPick {
  readonly id: string;
  readonly mode: ScanMode;
  readonly phase: "start" | "stop";
}

export const scanLabels: Record<ScanMode, string> = {
  accessibility: "Accessibility scan",
  navigation: "Measure the next navigation",
  reload: "Reload at this point",
  timespan: "Interaction timespan",
};

export const scanTitle = (scan: ScanPick) =>
  scan.phase === "stop" ? "End interaction timespan" : scanLabels[scan.mode];

const scanClauses: Record<ScanMode, string> = {
  accessibility: "run an accessibility scan",
  navigation: "measure the next navigation’s performance",
  reload: "reload and measure performance",
  timespan: "start measuring an interaction timespan",
};

const scanClause = (scan: ScanPick) =>
  scan.phase === "stop"
    ? "stop the interaction timespan"
    : scanClauses[scan.mode];

/** One step the user performed while recording. */
export interface Step {
  readonly at: string;
  readonly id: string;
  readonly label: string;
  /** The step as the end of "When …", for example `you click “Pay”`. */
  readonly when: string;
}

export const steps: readonly Step[] = [
  {
    at: "00:41",
    id: "s1",
    label: "Click “Add to cart”",
    when: "you click “Add to cart”",
  },
  {
    at: "01:12",
    id: "s2",
    label: "Type into “Email”",
    when: "you type into “Email”",
  },
  {
    at: "01:38",
    id: "s3",
    label: "Click “Submit order”",
    when: "you click “Submit order”",
  },
];

export const lastStepId = "s3";

/** A value the response showed that is safe to check against. */
export interface ResponseValue {
  readonly key: string;
  readonly segments?: readonly string[];
  readonly value: string;
}

export interface MockRequest {
  readonly kind: "request";
  readonly id: string;
  readonly method: string;
  readonly name: string;
  readonly url: string;
  readonly status: number;
  readonly type: string;
  /** The step this request followed. */
  readonly stepId: string;
  readonly offsetMs: number;
  readonly values: readonly ResponseValue[];
  /** Values the response had that stay private, such as tokens and ids. */
  readonly hiddenCount: number;
  readonly body: string | undefined;
}

export type StorageArea = "cookie" | "local" | "session";

export interface MockStorage {
  readonly observed?: boolean;
  readonly kind: "storage";
  readonly id: string;
  readonly area: StorageArea;
  readonly key: string;
  /** What happened to the key at its step. */
  readonly change: "created" | "changed" | "unchanged";
  readonly stepId: string;
  /** Only the browser devtools show this; checks never do. */
  readonly value: string;
}

export type Evidence = MockRequest | MockStorage;

export const requests: readonly MockRequest[] = [
  {
    body: JSON.stringify({
      data: {
        orders: [{ delivery: { address: { city: "Pune" } }, status: "ready" }],
      },
      orderId: "ord_9F2K",
      paymentToken: "tok_live_51Hx",
      status: "ready",
      total: "42.00",
    }),
    hiddenCount: 2,
    id: "r-order",
    kind: "request",
    method: "POST",
    name: "/api/order",
    offsetMs: 98_100,
    status: 201,
    stepId: "s3",
    type: "fetch",
    url: "https://shop.local/api/order",
    values: [
      { key: "status", value: "ready" },
      { key: "total", value: "42.00" },
      {
        key: "data.orders[0].status",
        segments: ["data", "orders", "[0]", "status"],
        value: "ready",
      },
      {
        key: "data.orders[0].delivery.address.city",
        segments: ["data", "orders", "[0]", "delivery", "address", "city"],
        value: "Pune",
      },
    ],
  },
  {
    body: JSON.stringify({ state: "confirmed" }),
    hiddenCount: 0,
    id: "r-status",
    kind: "request",
    method: "GET",
    name: "/api/order/ord_9F2K/status",
    offsetMs: 98_600,
    status: 200,
    stepId: "s3",
    type: "fetch",
    url: "https://shop.local/api/order/ord_9F2K/status",
    values: [{ key: "state", value: "confirmed" }],
  },
  {
    body: undefined,
    hiddenCount: 0,
    id: "r-collect",
    kind: "request",
    method: "POST",
    name: "/collect",
    offsetMs: 98_700,
    status: 204,
    stepId: "s3",
    type: "fetch",
    url: "https://events.shop.local/collect",
    values: [],
  },
  {
    body: JSON.stringify({ items: 2 }),
    hiddenCount: 0,
    id: "r-cart",
    kind: "request",
    method: "GET",
    name: "/api/cart",
    offsetMs: 41_200,
    status: 200,
    stepId: "s1",
    type: "fetch",
    url: "https://shop.local/api/cart",
    values: [{ key: "items", value: "2" }],
  },
  {
    body: JSON.stringify({ error: "expired" }),
    hiddenCount: 0,
    id: "r-refresh",
    kind: "request",
    method: "POST",
    name: "/api/session/refresh",
    offsetMs: 41_400,
    status: 401,
    stepId: "s1",
    type: "fetch",
    url: "https://shop.local/api/session/refresh",
    values: [],
  },
];

export const storageItems: readonly MockStorage[] = [
  {
    area: "cookie",
    change: "created",
    id: "c-random",
    key: "random-cookie",
    kind: "storage",
    stepId: "s3",
    value: "f3a9c2e1",
  },
  {
    area: "cookie",
    change: "unchanged",
    id: "c-session",
    key: "session_id",
    kind: "storage",
    stepId: "s1",
    value: "s%3A8d1e",
  },
  {
    area: "local",
    change: "changed",
    id: "l-cart",
    key: "cart",
    kind: "storage",
    stepId: "s3",
    value: '{"items":[]}',
  },
];

export const findStep = (id: string | undefined) =>
  steps.find((step) => step.id === id);
export const findRequest = (id: string) =>
  requests.find((request) => request.id === id);
export const findStorage = (id: string) =>
  storageItems.find((item) => item.id === id);

const stepIndex = (id: string | undefined) =>
  steps.findIndex((step) => step.id === id);

export const areaNouns: Record<StorageArea, string> = {
  cookie: "cookie",
  local: "local storage item",
  session: "session storage item",
};

export type RequestExpect =
  | { readonly kind: "succeeds" }
  | {
      readonly kind: "value";
      readonly key: string;
      readonly value: string;
      readonly operator?: "equals" | "contains";
    };

export type StorageChange = "changed" | "created" | "present" | "removed";

export const storageChangeLabels: Record<StorageChange, string> = {
  changed: "Gets a new value",
  created: "Is created",
  present: "Is there (may already exist)",
  removed: "Is deleted",
};

export type Check =
  | {
      readonly kind: "request";
      readonly requestId: string;
      readonly expect: RequestExpect;
    }
  | {
      readonly kind: "storage";
      readonly storageId: string;
      readonly evidence?: MockStorage;
      readonly change: StorageChange;
    };

export interface Condition {
  readonly attachments?: readonly Evidence[];
  readonly element?: ElementRef | undefined;
  readonly scan?: ScanPick | undefined;
  readonly id: string;
  readonly checks: readonly Check[];
  /** The step that should cause it, or `undefined` to check right now. */
  readonly stepId: string | undefined;
  /** Anything else, in the user's words. */
  readonly note: string;
}

export interface Draft {
  readonly attachments?: readonly Evidence[];
  readonly element?: ElementRef | undefined;
  readonly scan?: ScanPick | undefined;
  readonly editingId: string | undefined;
  readonly checks: readonly Check[];
  readonly stepId: string | undefined;
  readonly note: string;
}

export const emptyDraft: Draft = {
  checks: [],
  editingId: undefined,
  note: "",
  stepId: lastStepId,
};

export const evidenceOf = (check: Check): Evidence | undefined =>
  check.kind === "request"
    ? findRequest(check.requestId)
    : (check.evidence ?? findStorage(check.storageId));

export const evidenceId = (check: Check) =>
  check.kind === "request" ? check.requestId : check.storageId;

/** Picking evidence starts from the check most people mean by it. */
export const checkFor = (evidence: Evidence): Check =>
  evidence.kind === "request"
    ? { expect: { kind: "succeeds" }, kind: "request", requestId: evidence.id }
    : {
        change: evidence.change === "unchanged" ? "present" : evidence.change,
        evidence,
        kind: "storage",
        storageId: evidence.id,
      };

export const evidenceTitle = (evidence: Evidence) =>
  evidence.kind === "request"
    ? `${evidence.method} ${evidence.name}`
    : evidence.key;

const clause = (check: Check) => {
  if (check.kind === "request") {
    const request = findRequest(check.requestId);
    const name = request === undefined ? "a request" : evidenceTitle(request);
    return check.expect.kind === "succeeds"
      ? `the app must call ${name} and it must succeed`
      : `the app must call ${name} and return ${check.expect.key} ${check.expect.operator === "contains" ? "containing" : "equal to"} “${check.expect.value}”`;
  }
  const item = check.evidence ?? findStorage(check.storageId);
  const name =
    item === undefined
      ? "a stored item"
      : `${areaNouns[item.area]} ${item.key}`;
  const verbs: Record<StorageChange, string> = {
    changed: `the app must change the ${name}`,
    created: `the app must create the ${name}`,
    present: `the ${name} must be there`,
    removed: `the app must delete the ${name}`,
  };
  return verbs[check.change];
};

/** Whether picked evidence happened before the step that should cause it. */
export const isStale = (check: Check, stepId: string | undefined) => {
  if (stepId === undefined) {
    return false;
  }
  if (check.kind === "storage" && check.change === "present") {
    return false;
  }
  const evidence = evidenceOf(check);
  return (
    evidence !== undefined && stepIndex(evidence.stepId) < stepIndex(stepId)
  );
};

export interface Sentence {
  readonly text: string;
  readonly guard: string | undefined;
  readonly stale: boolean;
}

/** The plain sentence a person reads back before adding. */
export const describe = (
  draft: Pick<Draft, "checks" | "note" | "scan" | "stepId">
): Sentence => {
  const step = draft.checks.length > 0 ? findStep(draft.stepId) : undefined;
  const when = step === undefined ? "At this point" : `When ${step.when}`;
  const note = draft.note.trim();
  const clauses = [
    ...draft.checks.map(clause),
    ...(draft.scan === undefined ? [] : [scanClause(draft.scan)]),
  ];
  if (clauses.length === 0) {
    return { guard: undefined, stale: false, text: note };
  }
  let text = `${when}, ${clauses.join(", and ")}.`;
  if (note !== "") {
    text = `${text} Then: ${note}`;
  }
  const watches = draft.checks.some(
    (check) => check.kind === "request" || check.change !== "present"
  );
  return {
    guard:
      step !== undefined && watches
        ? `On later Runs, Contingency starts watching right before ${step.when}, so anything from earlier doesn’t count.`
        : undefined,
    stale: draft.checks.some((check) => isStale(check, draft.stepId)),
    text,
  };
};

export const canAdd = (draft: Draft) =>
  (draft.attachments?.length ?? 0) > 0 ||
  draft.element !== undefined ||
  draft.scan !== undefined ||
  draft.checks.length > 0 ||
  draft.note.trim() !== "";

/** The devtools panels, plus the Checks list one direction adds. */
export type DevtoolsPanelId = "checks" | "console" | "network" | "storage";

export interface PrototypeState {
  readonly conditions: readonly Condition[];
  /** The real browser devtools panel open beside the stage, if any. */
  readonly devtools: DevtoolsPanelId | undefined;
  readonly draft: Draft;
  readonly composing: boolean;
  /** Which popover or tab inside the composer is open, if any. */
  readonly surface: string | undefined;
  /** The request whose response the prototype devtools show, if any. */
  readonly detailId: string | undefined;
  /** Which storage area the prototype devtools list. */
  readonly storageArea: StorageArea;
  /** The attach menu's search text. */
  readonly menuQuery: string;
  /** What is being dragged out of the devtools, if anything. */
  readonly dragging: "evidence" | "field" | undefined;
  readonly nextId: number;
}

export const initialState: PrototypeState = {
  composing: true,
  conditions: [
    {
      checks: [],
      id: "c-seed-note",
      note: "Use the test card ending 4242.",
      stepId: undefined,
    },
    {
      checks: [{ change: "created", kind: "storage", storageId: "c-random" }],
      id: "c-seed",
      note: "",
      stepId: "s3",
    },
  ],
  detailId: undefined,
  devtools: "network",
  draft: emptyDraft,
  dragging: undefined,
  menuQuery: "",
  nextId: 1,
  storageArea: "cookie",
  surface: undefined,
};

/**
 * One state per approach, so switching keeps each direction's edits and all
 * four start from the same seeded recording.
 */
export const approachStateAtom = Atom.family((_approach: ApproachId) =>
  Atom.keepAlive(Atom.make<PrototypeState>(initialState))
);

export type ViewportId = "fill" | "large" | "medium";

export const galleryAtom = Atom.keepAlive(
  Atom.make<{ readonly approach: ApproachId; readonly viewport: ViewportId }>({
    approach: "drop",
    viewport: "large",
  })
);

export const setDraft = (
  state: PrototypeState,
  patch: Partial<Draft>
): PrototypeState => ({ ...state, draft: { ...state.draft, ...patch } });

export const addCheck = (state: PrototypeState, check: Check) => {
  const id = evidenceId(check);
  const exists = state.draft.checks.some((item) => evidenceId(item) === id);
  return setDraft(state, {
    checks: exists ? state.draft.checks : [...state.draft.checks, check],
  });
};

export const replaceCheck = (
  state: PrototypeState,
  index: number,
  check: Check
) =>
  setDraft(state, {
    checks: state.draft.checks.map((item, position) =>
      position === index ? check : item
    ),
  });

export const removeCheck = (state: PrototypeState, index: number) =>
  setDraft(state, {
    checks: state.draft.checks.filter((_, position) => position !== index),
  });

export const startEdit = (
  state: PrototypeState,
  condition: Condition
): PrototypeState => ({
  ...state,
  draft: {
    attachments: condition.attachments ?? [],
    checks: condition.checks,
    editingId: condition.id,
    element: condition.element,
    note: condition.note,
    scan: condition.scan,
    stepId: condition.stepId,
  },
});

export const commitDraft = (state: PrototypeState): PrototypeState => {
  const { draft } = state;
  const condition: Condition = {
    attachments: draft.attachments ?? [],
    checks: draft.checks,
    element: draft.element,
    id: draft.editingId ?? `c-${state.nextId}`,
    note: draft.note.trim(),
    scan: draft.scan,
    stepId: draft.checks.length > 0 ? draft.stepId : undefined,
  };
  return {
    ...state,
    conditions:
      draft.editingId === undefined
        ? [...state.conditions, condition]
        : state.conditions.map((item) =>
            item.id === draft.editingId ? condition : item
          ),
    draft: emptyDraft,
    nextId: draft.editingId === undefined ? state.nextId + 1 : state.nextId,
    surface: undefined,
  };
};

export const removeCondition = (
  state: PrototypeState,
  id: string
): PrototypeState => ({
  ...state,
  conditions: state.conditions.filter((item) => item.id !== id),
  draft: state.draft.editingId === id ? emptyDraft : state.draft,
});

/** The timespan a recording started and has not ended yet, if any. */
export const openTimespan = (conditions: readonly Condition[]) => {
  let open: ScanPick | undefined;
  for (const condition of conditions) {
    if (condition.scan?.mode === "timespan") {
      open = condition.scan.phase === "start" ? condition.scan : undefined;
    }
  }
  return open;
};

/** Attaches evidence once, as context. */
export const attach = (state: PrototypeState, evidence: Evidence) =>
  setDraft(state, {
    attachments: [
      ...(state.draft.attachments ?? []).filter(
        (item) => item.id !== evidence.id
      ),
      evidence,
    ],
  });

/** Drops evidence from the draft, whether it was context or a check. */
export const detach = (state: PrototypeState, id: string) =>
  setDraft(state, {
    attachments: (state.draft.attachments ?? []).filter(
      (item) => item.id !== id
    ),
    checks: state.draft.checks.filter((item) => evidenceId(item) !== id),
  });

/** Every piece of evidence on the draft, context and checks alike, in order. */
export const draftEvidence = (draft: Draft) => {
  const seen = new Map<string, Evidence>();
  for (const item of draft.attachments ?? []) {
    seen.set(item.id, item);
  }
  for (const check of draft.checks) {
    const evidence = evidenceOf(check);
    if (evidence !== undefined && !seen.has(evidence.id)) {
      seen.set(evidence.id, evidence);
    }
  }
  return [...seen.values()];
};

/** Makes attached evidence a requirement, or turns one back into context. */
export const setRequired = (
  state: PrototypeState,
  evidence: Evidence,
  required: boolean
) => {
  const { id } = evidence;
  if (required) {
    return addCheck(
      setDraft(state, {
        attachments: (state.draft.attachments ?? []).filter(
          (item) => item.id !== id
        ),
      }),
      checkFor(evidence)
    );
  }
  return attach(
    setDraft(state, {
      checks: state.draft.checks.filter((item) => evidenceId(item) !== id),
    }),
    evidence
  );
};

/** Updates the draft's check on this evidence in place. */
export const updateCheck = (state: PrototypeState, check: Check) =>
  setDraft(state, {
    checks: state.draft.checks.map((item) =>
      evidenceId(item) === evidenceId(check) ? check : item
    ),
  });

/** A cookie the user expects but has not seen; naming it never creates it. */
export const expectedCookie = (name: string, stepId: string): MockStorage => {
  const seen = storageItems.find(
    (item) => item.area === "cookie" && item.key === name
  );
  return (
    seen ?? {
      area: "cookie",
      change: "created",
      id: `cookie:${name}`,
      key: name,
      kind: "storage",
      observed: false,
      stepId,
      value: "",
    }
  );
};

/** A response field check, ready to add. */
export const fieldCheck = (
  request: MockRequest,
  field: ResponseValue
): Check => ({
  expect: { key: field.key, kind: "value", value: field.value },
  kind: "request",
  requestId: request.id,
});

/** Finds evidence by id, including names the user typed. */
export const findEvidence = (id: string): Evidence | undefined =>
  findRequest(id) ??
  findStorage(id) ??
  (id.startsWith("cookie:")
    ? expectedCookie(id.slice("cookie:".length), lastStepId)
    : undefined);

/** Puts a scan on the draft; ending a timespan reuses the open one's id. */
export const pickScan = (
  state: PrototypeState,
  scan: Omit<ScanPick, "id">
): PrototypeState => {
  const open = openTimespan(state.conditions);
  const id =
    scan.phase === "stop" && open !== undefined
      ? open.id
      : `scan-${state.nextId}-${scan.mode}`;
  return setDraft(state, { scan: { ...scan, id } });
};

/** The data type devtools rows carry while they are dragged. */
export const dragType = "application/x-contingency-evidence";

/** What a dragged devtools row or response field carries. */
const DragPayloadSchema = Schema.Union([
  Schema.Struct({ id: Schema.String, kind: Schema.Literal("evidence") }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal("field"),
    requestId: Schema.String,
  }),
]);
export type DragPayload = typeof DragPayloadSchema.Type;

const DragPayloadJson = Schema.fromJsonString(DragPayloadSchema);
export const encodeDrag = Schema.encodeSync(DragPayloadJson);
const decodeDragPayload = Schema.decodeUnknownOption(DragPayloadJson);

/** Reads a drop, ignoring anything that is not a devtools row or field. */
export const decodeDrag = (raw: string): DragPayload | undefined =>
  Option.getOrUndefined(decodeDragPayload(raw));

/** Applies a drop to the draft: rows attach as context, fields as checks. */
export const applyDrop = (
  state: PrototypeState,
  payload: DragPayload
): PrototypeState => {
  if (payload.kind === "evidence") {
    const evidence = findEvidence(payload.id);
    if (evidence === undefined) {
      return state;
    }
    const required = state.draft.checks.some(
      (check) => evidenceId(check) === evidence.id
    );
    return required ? state : attach(state, evidence);
  }
  const request = findRequest(payload.requestId);
  const field = request?.values.find((item) => item.key === payload.key);
  if (request === undefined || field === undefined) {
    return state;
  }
  const withoutContext = setDraft(state, {
    attachments: (state.draft.attachments ?? []).filter(
      (item) => item.id !== request.id
    ),
    checks: state.draft.checks.filter(
      (check) => evidenceId(check) !== request.id
    ),
  });
  return addCheck(withoutContext, fieldCheck(request, field));
};

/**
 * Records a check on its own, straight from the devtools, as a condition
 * caused by the last step. `surface` remembers it so the user can undo.
 */
export const addStandalone = (
  state: PrototypeState,
  patch: Pick<Condition, "checks"> & Partial<Pick<Condition, "scan">>
): PrototypeState => {
  const id = `c-${state.nextId}`;
  return {
    ...state,
    conditions: [
      ...state.conditions,
      {
        attachments: [],
        checks: patch.checks,
        id,
        note: "",
        scan: patch.scan,
        stepId: patch.checks.length > 0 ? lastStepId : undefined,
      },
    ],
    nextId: state.nextId + 1,
    surface: `added:${id}`,
  };
};

/** Changes one saved condition in place. */
export const updateCondition = (
  state: PrototypeState,
  id: string,
  patch: Partial<Condition>
): PrototypeState => ({
  ...state,
  conditions: state.conditions.map((item) =>
    item.id === id ? { ...item, ...patch } : item
  ),
});

/** The saved condition that already requires this evidence, if any. */
export const conditionRequiring = (
  conditions: readonly Condition[],
  id: string
) =>
  conditions.find((condition) =>
    condition.checks.some((check) => evidenceId(check) === id)
  );

/** What a check requires, in a few words for a chip. */
export const checkSummary = (check: Check) => {
  if (check.kind === "storage") {
    return `Must: ${storageChangeLabels[check.change].toLowerCase()}`;
  }
  if (check.expect.kind === "succeeds") {
    return "Must: succeed";
  }
  const operator = check.expect.operator === "contains" ? "∋" : "=";
  return `Must: ${check.expect.key} ${operator} ${check.expect.value}`;
};
