import { appendFileSync } from "node:fs";

import {
  AgentElementRef,
  AgentSnapshotId,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentScreenshot,
  AgentSnapshotNode,
  BrowserRpcErrorType,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";
import type { ElementHandle, JSHandle, Page } from "playwright-core";

import {
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_EXACT_FIELD_NAMES,
  SENSITIVE_FIELD_METADATA,
  SENSITIVE_FIELD_PHRASES,
  sanitizeTeachingUrl,
} from "./sensitive-data.ts";

/** How long one browser action or observation may take before it fails. */
const ACTION_TIMEOUT_MS = 10_000;

/** How many elements one Browser Snapshot describes. */
const SNAPSHOT_LIMIT = 300;

/** How long an accessible name may be before it is truncated. */
const NAME_LIMIT = 160;

/**
 * How many element references one Agent Session keeps alive at once. A long
 * journey takes many Browser Snapshots of one document, and every reference
 * holds a browser-side handle, so the oldest are released once past this.
 */
const REFERENCE_LIMIT = 1000;

const agentDebugLog = (
  hypothesisId: string,
  location: string,
  message: string,
  data: Readonly<Record<string, unknown>>
): void => {
  appendFileSync(
    "/opt/cursor/logs/debug.log",
    `${JSON.stringify({
      data,
      hypothesisId,
      location,
      message,
      timestamp: Date.now(),
    })}\n`
  );
};

/** Inputs whose values are never copied into a Browser Snapshot. */
const SENSITIVE_INPUT_SELECTOR = [
  '[type="password" i]',
  '[autocomplete^="current-password"]',
  '[autocomplete^="new-password"]',
  '[autocomplete="one-time-code"]',
  '[autocomplete^="cc-"]',
  ...SENSITIVE_FIELD_PHRASES.flatMap((term) => [
    `[name*="${term}" i]`,
    `[id*="${term}" i]`,
    `[aria-label*="${term}" i]`,
  ]),
  ...SENSITIVE_EXACT_FIELD_NAMES.flatMap((name) => [
    `[name="${name}" i]`,
    `[id="${name}" i]`,
    `[aria-label="${name}" i]`,
  ]),
  ...["4", "5", "6", "7", "8"].flatMap((length) => [
    `[inputmode="numeric"][maxlength="${length}"]`,
    `[inputmode="decimal"][maxlength="${length}"]`,
  ]),
].join(",");

const browserFailure = (
  description: string,
  cause: unknown
): BrowserRpcErrorType =>
  makeBrowserRpcError(
    "agent_browser_failed",
    `${description}: ${cause instanceof Error ? cause.message : String(cause)}`
  );

const staleReference = (ref: string): BrowserRpcErrorType =>
  makeBrowserRpcError(
    "agent_element_stale",
    `Element reference ${ref} is stale. Take a new Browser Snapshot: the Page navigated or the element left the document.`
  );

/**
 * What the Page is asked for. It collects the interactive controls, landmarks,
 * headings, and text a journey is described in — not the DOM — and hands back
 * the elements themselves so Contingency can mint references for them without
 * writing anything into the page under test.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const ROLE_BY_TAG = {
    A: "link",
    ARTICLE: "article",
    ASIDE: "complementary",
    BUTTON: "button",
    DIV: "generic",
    FOOTER: "contentinfo",
    FORM: "form",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    HEADER: "banner",
    IMG: "image",
    LABEL: "label",
    LI: "listitem",
    MAIN: "main",
    NAV: "navigation",
    OL: "list",
    P: "paragraph",
    SECTION: "region",
    SELECT: "combobox",
    SPAN: "generic",
    SUMMARY: "button",
    TABLE: "table",
    TD: "cell",
    TEXTAREA: "textbox",
    TH: "columnheader",
    TR: "row",
    UL: "list",
  };
  const INPUT_ROLES = {
    button: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    reset: "button",
    search: "searchbox",
    submit: "button",
  };
  const SENSITIVE_INPUT_SELECTOR = ${JSON.stringify(SENSITIVE_INPUT_SELECTOR)};
  const SENSITIVE_AUTOCOMPLETE = new RegExp(${JSON.stringify(SENSITIVE_AUTOCOMPLETE.source)}, "iu");
  const SENSITIVE_FIELD_METADATA = new RegExp(${JSON.stringify(SENSITIVE_FIELD_METADATA.source)}, "iu");
  const SENSITIVE_EXACT_FIELD_NAMES = new Set(${JSON.stringify(SENSITIVE_EXACT_FIELD_NAMES)});
  // Markup that declares itself a control or a landmark. An SPA row that
  // carries its handler in script matches none of this, so it is found by
  // cursor instead.
  const CONTROL_SELECTOR =
    "a[href],button,input,select,textarea,summary,[onclick]," +
    "[tabindex],[contenteditable=''],[contenteditable='true']," +
    "[role='button'],[role='link'],[role='checkbox'],[role='radio']," +
    "[role='switch'],[role='combobox'],[role='listbox'],[role='option']," +
    "[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']," +
    "[role='slider'],[role='spinbutton'],[role='textbox']," +
    "[role='searchbox'],[role='tab'],[role='treeitem']";
  const CONTEXT_SELECTOR =
    "[role]," +
    "h1,h2,h3,h4,h5,h6,main,nav,header,footer,form,li,td,th,p,label,img";
  const SKIPPED_TAGS = new Set([
    "BASE",
    "HEAD",
    "LINK",
    "META",
    "NOSCRIPT",
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "TITLE",
  ]);
  const isSensitive = (element) => {
    const metadataFields = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .map((value) => value.trim().toLowerCase());
    const metadata = metadataFields.join(" ");
    const inputMode = element.getAttribute("inputmode")?.toLowerCase();
    const maxLength = Number(element.getAttribute("maxlength"));
    const looksLikeUnlabelledCode =
      (inputMode === "numeric" || inputMode === "decimal") &&
      Number.isInteger(maxLength) &&
      maxLength >= 4 &&
      maxLength <= 8;
    return (
      element.getAttribute("type")?.toLowerCase() === "password" ||
      SENSITIVE_AUTOCOMPLETE.test(
        element.getAttribute("autocomplete") || ""
      ) ||
      SENSITIVE_FIELD_METADATA.test(metadata) ||
      metadataFields.some((value) => SENSITIVE_EXACT_FIELD_NAMES.has(value)) ||
      looksLikeUnlabelledCode
    );
  };
  const sensitiveValues = Array.from(
    document.querySelectorAll('input,textarea,select,[role="textbox"]')
  )
    .filter(isSensitive)
    .map((element) => element.value)
    // Short segmented-code values are not safe global redaction tokens. A
    // one-character OTP box must not rewrite every matching digit in the
    // Page before Contingency can redact the complete declared Variable.
    .filter((value) => typeof value === "string" && value.length >= 4)
    .sort((left, right) => right.length - left.length);
  const redactSensitive = (text) =>
    sensitiveValues.reduce(
      (redacted, value) => redacted.split(value).join("[sensitive input]"),
      text
    );
  // One computed style per element: visibility and the cursor test below both
  // read it, and the cursor test reads the parent's as well.
  const styles = new Map();
  const styleOf = (element) => {
    let style = styles.get(element);
    if (style === undefined) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const isVisible = (element) => {
    const style = styleOf(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  // A pointer cursor inherits, so every descendant of a clickable row reports
  // one too. Only the outermost element of such a run is the control.
  const isPointerRoot = (element) => {
    if (styleOf(element).cursor !== "pointer") {
      return false;
    }
    const parent = element.parentElement;
    return parent === null || styleOf(parent).cursor !== "pointer";
  };
  // The smallest element owning a run of text, so a label is reported once
  // rather than once per wrapper on the way down to it.
  const ownsText = (element) => {
    for (const child of element.childNodes) {
      if (child.nodeType === 3 && child.nodeValue.trim() !== "") {
        return true;
      }
    }
    return false;
  };
  const accessibleName = (element) => {
    const labelled = element.getAttribute("aria-labelledby");
    const labelledText =
      labelled === null
        ? ""
        : labelled
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ");
    const label =
      element.labels && element.labels.length > 0
        ? element.labels[0].textContent || ""
        : "";
    const own =
      element.getAttribute("aria-label") ||
      labelledText ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      label ||
      element.textContent ||
      "";
    return own.replace(/\\s+/g, " ").trim().slice(0, ${NAME_LIMIT});
  };
  // Controls come before prose when the budget runs out: a journey is driven
  // by what it can act on, and a Page that overflows the limit is one whose
  // text matters least.
  const controls = [];
  const contextual = [];
  const clickable = new Set();
  const textual = [];
  for (const element of document.querySelectorAll("*")) {
    if (SKIPPED_TAGS.has(element.tagName) || !isVisible(element)) {
      continue;
    }
    if (element.matches(CONTROL_SELECTOR)) {
      controls.push(element);
      continue;
    }
    if (isPointerRoot(element)) {
      clickable.add(element);
      controls.push(element);
      continue;
    }
    if (element.matches(CONTEXT_SELECTOR)) {
      contextual.push(element);
      continue;
    }
    if (ownsText(element)) {
      textual.push(element);
    }
  }
  const candidates = controls.slice(0, ${SNAPSHOT_LIMIT});
  const contextBudget = Math.max(0, ${SNAPSHOT_LIMIT} - candidates.length);
  candidates.push(...contextual.slice(0, contextBudget));
  const textBudget = Math.max(0, ${SNAPSHOT_LIMIT} - candidates.length);
  candidates.push(...textual.slice(0, textBudget));
  const included = new Set(candidates);
  const elements = [];
  const nodes = [];
  for (const element of candidates) {
    const isInput = element.tagName === "INPUT";
    const tagRole = isInput
      ? INPUT_ROLES[element.type] || "textbox"
      : ROLE_BY_TAG[element.tagName] || element.tagName.toLowerCase();
    const role = element.getAttribute("role") || tagRole;
    const name = redactSensitive(accessibleName(element));
    let depth = 0;
    for (
      let ancestor = element.parentElement;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      if (included.has(ancestor)) {
        depth += 1;
      }
    }
    const bounds = element.getBoundingClientRect();
    const node = {
      depth: Math.min(depth, 64),
      height: bounds.height,
      name,
      role,
      width: bounds.width,
      x: bounds.x,
      y: bounds.y,
    };
    if (clickable.has(element)) {
      node.clickable = true;
    }
    if (element.disabled === true) {
      node.disabled = true;
    }
    if (typeof element.checked === "boolean") {
      node.checked = element.checked;
    }
    if (typeof element.value === "string" && !isSensitive(element)) {
      node.value = element.value.slice(0, ${NAME_LIMIT});
    }
    nodes.push(node);
    elements.push(element);
  }
  return {
    elements,
    focusedIndex: elements.indexOf(document.activeElement),
    nodes,
    title: document.title,
    url: location.href,
  };
})()`;

/** The page is untrusted, so everything it answers with is decoded on arrival. */
const CollectedNodes = Schema.Array(
  Schema.Struct({
    checked: Schema.optional(Schema.Boolean),
    clickable: Schema.optional(Schema.Boolean),
    depth: Schema.Int,
    disabled: Schema.optional(Schema.Boolean),
    height: Schema.Finite,
    name: Schema.String,
    role: Schema.String,
    value: Schema.optional(Schema.String),
    width: Schema.Finite,
    x: Schema.Finite,
    y: Schema.Finite,
  })
);
const CollectedPage = Schema.Struct({
  focusedIndex: Schema.Int,
  title: Schema.String,
  url: Schema.String,
});

const property = (
  handle: JSHandle<unknown>,
  name: string
): Effect.Effect<JSHandle<unknown>, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) =>
      browserFailure("Could not read the Browser Snapshot", cause),
    try: () => handle.getProperty(name),
  });

/** A handle whose page is already gone cannot be disposed, and need not be. */
const ignoreDisposeFailure = (): undefined => undefined;

const disposeHandles = (
  handles: Iterable<JSHandle<unknown>>
): Effect.Effect<void> =>
  Effect.promise(async () => {
    await Promise.all(
      [...handles].map((handle) => handle.dispose().catch(ignoreDisposeFailure))
    );
  });

/**
 * The Browser Snapshots one Agent Session has minted references from.
 *
 * References are short-lived by construction. They expire when the Page
 * navigates away from the document they were read in, and when the element
 * they name leaves that document. They are numbered from a counter that never
 * restarts, so a reference from an earlier Snapshot can only ever miss — it
 * can never quietly resolve to whatever now occupies its old position.
 * Nothing is written into the page, so a Snapshot never changes the website
 * under test.
 */
export interface AgentElementRegistry {
  /** Drop every reference, releasing the handles the browser still holds. */
  readonly clear: () => Effect.Effect<void>;
  /** Resolve a reference, or fail with a structured stale-reference error. */
  readonly resolve: (
    ref: string
  ) => Effect.Effect<ElementHandle, BrowserRpcErrorType>;
  /** Determine whether a referenced control is known to contain sensitive data. */
  readonly isSensitive: (
    ref: string
  ) => Effect.Effect<boolean, BrowserRpcErrorType>;
  /** A document-local selector for masking a field already marked private. */
  readonly privateSelector: (
    ref: string,
    segmentCount?: number
  ) => Effect.Effect<string, BrowserRpcErrorType>;
  /** Resolve viewport coordinates through the most recent Snapshot. */
  readonly pointRef: (
    x: number,
    y: number
  ) => Effect.Effect<AgentElementRef, BrowserRpcErrorType>;
  /** Resolve the currently focused element to one minted reference. */
  readonly focusedRef: () => Effect.Effect<
    AgentElementRef,
    BrowserRpcErrorType
  >;
  /** Read the Page and mint a new generation of references for it. */
  readonly snapshot: (
    page: Page
  ) => Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType>;
}

export const makeAgentElementRegistry = (
  now: () => Date = () => new Date()
): AgentElementRegistry => {
  const elements = new Map<string, ElementHandle>();
  const bounds = new Map<
    string,
    {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    }
  >();
  let generation = 0;
  /** Never reset: a reference names one element of one Snapshot, forever. */
  let minted = 0;
  /** The document the live references were read in. */
  let documentUrl: string | undefined;
  /** The focused reference minted by the most recent Snapshot. */
  let focused: AgentElementRef | undefined;

  const clear = (): Effect.Effect<void> => {
    const handles = [...elements.values()];
    elements.clear();
    bounds.clear();
    documentUrl = undefined;
    focused = undefined;
    return disposeHandles(handles);
  };

  /** Release the oldest references once the session is tracking too many. */
  const trim = (): Effect.Effect<void> => {
    const excess = elements.size - REFERENCE_LIMIT;
    if (excess <= 0) {
      return Effect.void;
    }
    const released: ElementHandle[] = [];
    for (const [ref, handle] of elements) {
      if (released.length >= excess) {
        break;
      }
      released.push(handle);
      elements.delete(ref);
      bounds.delete(ref);
    }
    return disposeHandles(released);
  };

  const snapshot = (
    page: Page
  ): Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType> =>
    Effect.gen(function* captureBrowserSnapshot() {
      // A navigation ends every reference read in the old document. Snapshots
      // of the same document add references rather than replacing them, so a
      // reference stays usable until its element leaves the page.
      if (documentUrl !== undefined && documentUrl !== page.url()) {
        yield* clear();
      }
      generation += 1;
      const snapshotId = AgentSnapshotId.make(`snapshot-${generation}`);
      const collected = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          catch: (cause) => browserFailure("Could not read the Page", cause),
          try: () => page.evaluateHandle<unknown>(SNAPSHOT_SCRIPT),
        }),
        (handle) =>
          Effect.gen(function* readCollectedPage() {
            const nodesHandle = yield* property(handle, "nodes");
            const elementsHandle = yield* property(handle, "elements");
            const rawNodes = yield* Effect.tryPromise({
              catch: (cause) =>
                browserFailure("Could not read the Browser Snapshot", cause),
              try: () => nodesHandle.jsonValue(),
            });
            const titleHandle = yield* property(handle, "title");
            const urlHandle = yield* property(handle, "url");
            const focusedIndexHandle = yield* property(handle, "focusedIndex");
            const rawPage = yield* Effect.tryPromise({
              catch: (cause) =>
                browserFailure("Could not read the Browser Snapshot", cause),
              try: async () => ({
                focusedIndex: await focusedIndexHandle.jsonValue(),
                title: await titleHandle.jsonValue(),
                url: await urlHandle.jsonValue(),
              }),
            });
            const handles = yield* Effect.tryPromise({
              catch: (cause) =>
                browserFailure("Could not read the Browser Snapshot", cause),
              try: () => elementsHandle.getProperties(),
            });
            yield* disposeHandles([
              elementsHandle,
              focusedIndexHandle,
              nodesHandle,
              titleHandle,
              urlHandle,
            ]);
            return { handles, rawNodes, rawPage };
          }),
        (handle) => disposeHandles([handle])
      );
      const decodedNodes = yield* Schema.decodeUnknownEffect(CollectedNodes)(
        collected.rawNodes
      ).pipe(
        Effect.mapError(() =>
          makeBrowserRpcError(
            "agent_browser_failed",
            "The Page answered a Browser Snapshot that could not be decoded."
          )
        )
      );
      const identity = yield* Schema.decodeUnknownEffect(CollectedPage)(
        collected.rawPage
      ).pipe(
        Effect.orElseSucceed(() => ({
          focusedIndex: -1,
          title: "",
          url: page.url(),
        }))
      );
      // #region agent log
      agentDebugLog("C", "agent-browser.ts:snapshot-collected", "Snapshot script result", {
        headingNames: decodedNodes
          .filter(({ role }) => role === "heading")
          .map(({ name }) => name),
        identityUrl: identity.url,
        pageUrl: page.url(),
      });
      // #endregion
      const nodes: AgentSnapshotNode[] = [];
      const orphaned: JSHandle<unknown>[] = [];
      focused = undefined;
      let index = 0;
      for (const [, entry] of collected.handles) {
        const element = entry.asElement();
        const collectedNode = decodedNodes[index];
        index += 1;
        if (element === null || collectedNode === undefined) {
          orphaned.push(entry);
          continue;
        }
        const { height, width, x, y, ...node } = collectedNode;
        minted += 1;
        const ref = AgentElementRef.make(`e${minted}`);
        elements.set(ref, element);
        bounds.set(ref, { height, width, x, y });
        if (index - 1 === identity.focusedIndex) {
          focused = ref;
        }
        nodes.push({ ...node, ref });
      }
      yield* disposeHandles(orphaned);
      documentUrl = identity.url;
      yield* trim();
      return {
        capturedAt: now().toISOString(),
        nodes,
        snapshotId,
        title: identity.title,
        url: sanitizeTeachingUrl(identity.url),
      };
    });

  const resolve = (
    ref: string
  ): Effect.Effect<ElementHandle, BrowserRpcErrorType> => {
    const handle = elements.get(ref);
    if (handle === undefined) {
      return Effect.fail(staleReference(ref));
    }
    return Effect.tryPromise({
      catch: () => staleReference(ref),
      try: () => handle.evaluate((element) => element.isConnected),
    }).pipe(
      Effect.flatMap((connected) =>
        connected ? Effect.succeed(handle) : Effect.fail(staleReference(ref))
      )
    );
  };

  const isSensitive = (
    ref: string
  ): Effect.Effect<boolean, BrowserRpcErrorType> =>
    resolve(ref).pipe(
      Effect.flatMap((element) =>
        Effect.tryPromise({
          catch: (cause) =>
            browserFailure("Could not inspect the referenced control", cause),
          try: () =>
            element.evaluate(
              (candidate, patterns) => {
                const metadataFields = [
                  candidate.getAttribute("name"),
                  candidate.getAttribute("id"),
                  candidate.getAttribute("aria-label"),
                ]
                  .filter(Boolean)
                  .map((value) => value.trim().toLowerCase());
                const metadata = metadataFields.join(" ");
                const autocomplete =
                  candidate.getAttribute("autocomplete") ?? "";
                const inputMode = candidate
                  .getAttribute("inputmode")
                  ?.toLowerCase();
                const maxLength = Number(candidate.getAttribute("maxlength"));
                const sensitiveMetadata = new RegExp(patterns.metadata, "iu");
                const sensitiveAutocomplete = new RegExp(
                  patterns.autocomplete,
                  "iu"
                );
                const exactNames = new Set(patterns.exactNames);
                const looksLikeUnlabelledCode =
                  (inputMode === "numeric" || inputMode === "decimal") &&
                  Number.isInteger(maxLength) &&
                  maxLength >= 4 &&
                  maxLength <= 8;
                return (
                  candidate.getAttribute("type")?.toLowerCase() ===
                    "password" ||
                  sensitiveAutocomplete.test(autocomplete) ||
                  sensitiveMetadata.test(metadata) ||
                  metadataFields.some((value) => exactNames.has(value)) ||
                  looksLikeUnlabelledCode
                );
              },
              {
                autocomplete: SENSITIVE_AUTOCOMPLETE.source,
                exactNames: [...SENSITIVE_EXACT_FIELD_NAMES],
                metadata: SENSITIVE_FIELD_METADATA.source,
              }
            ),
        })
      )
    );

  const focusedRef = (): Effect.Effect<AgentElementRef, BrowserRpcErrorType> =>
    focused === undefined
      ? Effect.fail(
          makeBrowserRpcError(
            "agent_element_stale",
            "No focused control has a current element reference. Focus the private field and try again."
          )
        )
      : Effect.succeed(focused);

  const privateSelector = (
    ref: string,
    segmentCount = 1
  ): Effect.Effect<string, BrowserRpcErrorType> =>
    resolve(ref).pipe(
      Effect.flatMap((element) =>
        Effect.tryPromise({
          catch: (cause) =>
            browserFailure("Could not identify the private control", cause),
          try: () =>
            element.evaluate((candidate, requestedCount) => {
              const selectorFor = (target: typeof candidate) => {
                const selectorParts: string[] = [];
                let current: typeof candidate | null = target;
                while (
                  current !== null &&
                  current !== current.ownerDocument.documentElement
                ) {
                  const parent = current.parentElement;
                  if (parent === null) {
                    break;
                  }
                  const siblings = [...parent.children];
                  selectorParts.unshift(
                    `${current.tagName.toLowerCase()}:nth-child(${siblings.indexOf(current) + 1})`
                  );
                  current = parent;
                }
                return `html > ${selectorParts.join(" > ")}`;
              };
              if (
                requestedCount <= 1 ||
                candidate.tagName !== "INPUT" ||
                Number(candidate.getAttribute("maxlength")) !== 1
              ) {
                return selectorFor(candidate);
              }
              const compatible = (control: typeof candidate) =>
                control.tagName === "INPUT" &&
                !control.hasAttribute("disabled") &&
                Number(control.getAttribute("maxlength")) === 1 &&
                control.getAttribute("type") ===
                  candidate.getAttribute("type") &&
                control.getAttribute("inputmode") ===
                  candidate.getAttribute("inputmode");
              let current: typeof candidate | null = candidate.parentElement;
              while (
                current !== null &&
                current !== current.ownerDocument.documentElement
              ) {
                const controls = [...current.querySelectorAll("input")].filter(
                  compatible
                );
                const start = controls.indexOf(candidate);
                if (
                  start !== -1 &&
                  controls.length === requestedCount &&
                  controls.length - start === requestedCount
                ) {
                  return controls.map(selectorFor).join(",");
                }
                current = current.parentElement;
              }
              return selectorFor(candidate);
            }, segmentCount),
        })
      )
    );

  const pointRef = (
    x: number,
    y: number
  ): Effect.Effect<AgentElementRef, BrowserRpcErrorType> => {
    const matches = [...bounds].filter(
      ([, rectangle]) =>
        x >= rectangle.x &&
        x <= rectangle.x + rectangle.width &&
        y >= rectangle.y &&
        y <= rectangle.y + rectangle.height
    );
    const [closest] = matches.toSorted(
      ([, left], [, right]) =>
        left.width * left.height - right.width * right.height
    );
    return closest === undefined
      ? Effect.fail(
          makeBrowserRpcError(
            "agent_element_stale",
            "No control in the current Browser Snapshot contains that point."
          )
        )
      : Effect.succeed(AgentElementRef.make(closest[0]));
  };

  return {
    clear,
    focusedRef,
    isSensitive,
    pointRef,
    privateSelector,
    resolve,
    snapshot,
  };
};

const REDACTED = "[sensitive input]";

const redactKnownValues = (text: string, values: readonly string[]): string => {
  if (values.includes(text)) {
    return REDACTED;
  }
  let redacted = text;
  for (const value of values) {
    if (value.length < 4) {
      continue;
    }
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
};

/**
 * A control's own value is redacted whenever it is any part of a known private
 * value, not only the whole of it. Split one-time-code inputs hold one
 * character each, so the digit-per-box form of a declared Variable is
 * reassembleable from Snapshot values that the length-bounded rewrite above
 * deliberately refuses to apply to free page text. Over-redacting a public
 * control that happens to hold a segment of a secret is the safe direction.
 */
const redactControlValue = (
  value: string,
  values: readonly string[]
): string => {
  if (value.length === 0) {
    return value;
  }
  return values.some((known) => known.includes(value))
    ? REDACTED
    : redactKnownValues(value, values);
};

/** Remove session-known private values from every textual Snapshot field. */
export const redactAgentSnapshot = (
  snapshot: AgentBrowserSnapshot,
  values: readonly string[]
): AgentBrowserSnapshot => ({
  ...snapshot,
  nodes: snapshot.nodes.map((node) => ({
    ...node,
    name: redactKnownValues(node.name, values),
    ...(node.value === undefined
      ? {}
      : { value: redactControlValue(node.value, values) }),
  })),
  title: redactKnownValues(snapshot.title, values),
});

export const captureAgentScreenshot = (
  page: Page,
  now: () => Date = () => new Date(),
  maskSensitive = false,
  privateValues: readonly string[] = [],
  privateSelectors: readonly string[] = []
): Effect.Effect<AgentScreenshot, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) => browserFailure("Could not capture a screenshot", cause),
    try: async () => {
      const controls = page.locator(
        'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]'
      );
      const privateIndexes =
        privateValues.length === 0
          ? []
          : await controls.evaluateAll((elements, values) => {
              const known = new Set(values);
              return elements.flatMap((element, index) => {
                const value =
                  "value" in element
                    ? String(element.value)
                    : (element.textContent ?? "");
                return known.has(value) ? [index] : [];
              });
            }, privateValues);
      const textElements = page.locator("body *");
      // Free page text is scanned only for values long enough to be a
      // meaningful match. A one-character Variable would otherwise black out
      // most of a Teaching screenshot; its control is already masked above.
      const textValues = privateValues.filter((value) => value.length >= 4);
      const privateTextIndexes =
        textValues.length === 0
          ? []
          : await textElements.evaluateAll(
              (elements, values) =>
                elements.flatMap((element, index) => {
                  const ownText = [...element.childNodes]
                    .filter((node) => node.nodeType === 3)
                    .map((node) => node.textContent ?? "")
                    .join(" ");
                  return values.some((value) => ownText.includes(value))
                    ? [index]
                    : [];
                }),
              textValues
            );
      return page.screenshot({
        ...(maskSensitive
          ? {
              mask: [
                page.locator(SENSITIVE_INPUT_SELECTOR),
                ...privateSelectors.map((selector) => page.locator(selector)),
                ...privateIndexes.map((index) => controls.nth(index)),
                ...privateTextIndexes.map((index) => textElements.nth(index)),
              ],
              maskColor: "#000000",
            }
          : {}),
        timeout: ACTION_TIMEOUT_MS,
        type: "png",
      });
    },
  }).pipe(
    Effect.map((image) => ({
      capturedAt: now().toISOString(),
      encoding: "base64" as const,
      format: "png" as const,
      image: image.toString("base64"),
      url: sanitizeTeachingUrl(page.url()),
    }))
  );

/** How long a post-action read waits for a navigation the action started. */
const SETTLE_TIMEOUT_MS = 5000;

/**
 * Read the Page after an action. A document navigation destroys the execution
 * context the Snapshot script runs in, while a same-document navigation keeps
 * that context and commits its destination UI on a following render. Settle
 * the kind that occurred and, if the read still lost a document-navigation
 * race, settle and read once more.
 */
export const snapshotAfterAction = (
  page: Page,
  registry: AgentElementRegistry,
  urlBefore: string = page.url()
): Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType> => {
  // #region agent log
  agentDebugLog("D", "agent-browser.ts:snapshotAfterAction-entry", "Post-action snapshot entered", {
    pageUrl: page.url(),
    urlBefore,
  });
  // #endregion
  const settle = Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      if (page.url() === urlBefore) {
        // #region agent log
        agentDebugLog("D", "agent-browser.ts:settle-same-url", "Settling unchanged URL branch", {
          pageUrl: page.url(),
          urlBefore,
        });
        // #endregion
        await page.waitForLoadState("domcontentloaded", {
          timeout: SETTLE_TIMEOUT_MS,
        });
        return;
      }
      // #region agent log
      agentDebugLog("A", "agent-browser.ts:settle-changed-url", "Settling changed URL branch", {
        pageUrl: page.url(),
        urlBefore,
      });
      // #endregion
      await page.waitForURL((url) => url.href !== urlBefore, {
        timeout: SETTLE_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          })
      );
      // #region agent log
      agentDebugLog("A,B", "agent-browser.ts:settle-complete", "Playwright settling completed", {
        pageUrl: page.url(),
      });
      // #endregion
    },
  }).pipe(Effect.ignore);
  const read = settle.pipe(Effect.andThen(() => registry.snapshot(page)));
  return read.pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        // #region agent log
        agentDebugLog("C,E", "agent-browser.ts:snapshotAfterAction-exit", "Post-action snapshot completed", {
          headingNames: snapshot.nodes
            .filter(({ role }) => role === "heading")
            .map(({ name }) => name),
          snapshotUrl: snapshot.url,
        });
        // #endregion
      })
    ),
    Effect.catchCause(() => read)
  );
};

const attempt = <A>(
  description: string,
  operation: () => Promise<A>
): Effect.Effect<A, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) => browserFailure(description, cause),
    try: operation,
  });

/** Resolve a reference and act on the element it still names, or fail. */
const onElement = (
  registry: AgentElementRegistry,
  ref: string,
  description: string,
  operation: (element: ElementHandle) => Promise<unknown>
): Effect.Effect<void, BrowserRpcErrorType> =>
  registry
    .resolve(ref)
    .pipe(
      Effect.flatMap((element) =>
        attempt(description, () => operation(element)).pipe(Effect.asVoid)
      )
    );

const unreachableAction = (action: never): never => {
  throw new Error(`Unhandled agent action: ${JSON.stringify(action)}`);
};

/**
 * Perform one reversible agent action. Every element the action names comes
 * from a Browser Snapshot this session minted, so an agent can never reach
 * past the observation boundary into a raw selector or a Playwright object.
 */
export const performAgentAction = (
  page: Page,
  registry: AgentElementRegistry,
  action: AgentBrowserAction
): Effect.Effect<void, BrowserRpcErrorType> => {
  switch (action.type) {
    case "navigate": {
      return attempt(
        `Could not navigate to ${sanitizeTeachingUrl(action.url)}`,
        () => page.goto(action.url, { timeout: ACTION_TIMEOUT_MS })
      ).pipe(Effect.asVoid);
    }
    case "history": {
      return attempt(`Could not go ${action.action}`, () => {
        if (action.action === "reload") {
          return page.reload({ timeout: ACTION_TIMEOUT_MS });
        }
        return action.action === "back"
          ? page.goBack({ timeout: ACTION_TIMEOUT_MS })
          : page.goForward({ timeout: ACTION_TIMEOUT_MS });
      }).pipe(Effect.asVoid);
    }
    case "click": {
      return onElement(
        registry,
        action.ref,
        `Could not click ${action.ref}`,
        (element) => element.click({ timeout: ACTION_TIMEOUT_MS })
      );
    }
    case "hover": {
      return onElement(
        registry,
        action.ref,
        `Could not hover ${action.ref}`,
        (element) => element.hover({ timeout: ACTION_TIMEOUT_MS })
      );
    }
    case "fill": {
      return onElement(
        registry,
        action.ref,
        `Could not fill ${action.ref}`,
        (element) => element.fill(action.text, { timeout: ACTION_TIMEOUT_MS })
      );
    }
    case "select": {
      return onElement(
        registry,
        action.ref,
        `Could not select an option in ${action.ref}`,
        (element) =>
          element.selectOption([...action.values], {
            timeout: ACTION_TIMEOUT_MS,
          })
      );
    }
    case "press": {
      const { ref } = action;
      return ref === undefined
        ? attempt("Could not press a key", () =>
            page.keyboard.press(action.key)
          )
        : onElement(
            registry,
            ref,
            `Could not press a key on ${ref}`,
            (element) =>
              element.press(action.key, { timeout: ACTION_TIMEOUT_MS })
          );
    }
    case "scroll": {
      const { ref } = action;
      return ref === undefined
        ? attempt("Could not scroll the Page", () =>
            page.mouse.wheel(action.deltaX, action.deltaY)
          )
        : onElement(registry, ref, `Could not scroll ${ref}`, (element) =>
            element.evaluate(
              (target, delta) => {
                target.scrollBy(delta.x, delta.y);
              },
              { x: action.deltaX, y: action.deltaY }
            )
          );
    }
    case "wait_for_text": {
      return attempt(`Could not find "${action.text}"`, () =>
        page
          .getByText(action.text)
          .first()
          .waitFor({
            state: "visible",
            timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS,
          })
      );
    }
    default: {
      // A new action member fails to compile here rather than being silently
      // performed as whichever branch happened to be last.
      return unreachableAction(action);
    }
  }
};

/**
 * Enter one private Variable and prove that the target controls accepted it.
 * A comma-separated selector represents a split input such as six OTP boxes.
 */
export const performPrivateVariableInput = (
  page: Page,
  selector: string,
  value: string
): Effect.Effect<void, BrowserRpcErrorType> =>
  attempt("Could not enter the private Variable", async () => {
    const controls = page.locator(selector);
    const count = await controls.count();
    const characters = [...value];
    if (count === 0) {
      throw new Error("The private control is no longer available.");
    }
    if (count > 1 && count !== characters.length) {
      throw new Error(
        "The split private control does not match the Variable length."
      );
    }

    const readValues = async (): Promise<readonly string[] | undefined> => {
      if ((await controls.count()) === 0) {
        return undefined;
      }
      return controls.evaluateAll((elements) =>
        elements.map((element) =>
          "value" in element
            ? String(element.value)
            : (element.textContent ?? "")
        )
      );
    };
    const fillEach = async (
      values: readonly string[],
      index = 0
    ): Promise<void> => {
      const next = values[index];
      if (next === undefined) {
        return;
      }
      await controls.nth(index).fill(next, { timeout: ACTION_TIMEOUT_MS });
      await fillEach(values, index + 1);
    };
    await controls.first().fill(value, { timeout: ACTION_TIMEOUT_MS });
    const initiallyAccepted = await readValues();
    if (initiallyAccepted === undefined) {
      return;
    }
    let accepted = initiallyAccepted.join("");
    if (accepted === value) {
      return;
    }
    if (count === 1) {
      throw new Error("The private control did not accept the value.");
    }

    await fillEach(Array.from({ length: count }, () => ""));
    await fillEach(characters);
    const finallyAccepted = await readValues();
    if (finallyAccepted === undefined) {
      return;
    }
    accepted = finallyAccepted.join("");
    if (accepted !== value) {
      throw new Error("The split private control did not accept the value.");
    }
  }).pipe(Effect.asVoid);
