import {
  AgentElementRef,
  AgentSnapshotId,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AgentActionEffect,
  AgentActionSignal,
  AgentActionSubject,
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentPageActivity,
  AgentPageSettle,
  AgentScreenshot,
  AgentSnapshotNode,
  BrowserRpcErrorType,
} from "@contingency/protocol";
import { Effect, Option, Schema } from "effect";
import type { ElementHandle, JSHandle, Page } from "playwright-core";

import { networkQuietFor } from "./page-activity.ts";
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

const isIndex = (index: unknown): index is number =>
  typeof index === "number" && Number.isInteger(index) && index >= 0;

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
 * The constants and helpers both page-reading scripts share: visibility, the
 * text a reader would hear, and the accessible-name precedence. A wait and a
 * Snapshot that computed names differently would disagree about what the Page
 * says, which is exactly the trap a done-when phrase falls into.
 */
const PAGE_READING_PRELUDE = `
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
    ARTICLE: "article",
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
    "h1,h2,h3,h4,h5,h6,main,nav,header,footer,form,article,li,td,th,p,label,img";
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
  // What the accessibility tree keeps: an element the styling hides, or one
  // \`aria-hidden\` removes, is not there for a reader and is not here either.
  // The subtree goes with it, so a descendant of a hidden element is hidden
  // however it styles itself.
  const isRendered = (element) => {
    if (SKIPPED_TAGS.has(element.tagName)) {
      return false;
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = styleOf(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const isVisible = (element) => {
    for (
      let node = element;
      node !== null && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (!isRendered(node)) {
        return false;
      }
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  // The text a reader would hear for a container: its own text plus that of
  // every descendant still in the accessibility tree. Reading \`textContent\`
  // instead folds a hidden empty-state message into the name of the region
  // that deliberately hides it.
  const renderedText = (element) => {
    let text = "";
    for (const child of element.childNodes) {
      if (child.nodeType === 3) {
        text += child.nodeValue;
        continue;
      }
      if (child.nodeType === 1 && isRendered(child)) {
        text += \` \${renderedText(child)}\`;
      }
    }
    return text;
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
  // The label that names a control: one bound by \`for\`, or one wrapping it.
  // \`labels\` covers both for a form control, and \`closest\` covers the
  // wrapped case for anything naming itself a control through \`role\`.
  const labelFor = (element) => {
    if (element.labels && element.labels.length > 0) {
      return element.labels[0];
    }
    if (element.tagName === "LABEL" || !element.matches(CONTROL_SELECTOR)) {
      return null;
    }
    return element.closest("label");
  };
  // The accessible name computation's precedence, in the order a screen
  // reader applies it. \`placeholder\` is the last resort it is in the
  // standard, not the first thing a text field answers with: a control with a
  // visible label is asked for by that label, in a Flow Skill and in a
  // recorded Teaching action alike.
  const accessibleName = (element) => {
    const labelled = element.getAttribute("aria-labelledby");
    const labelledText =
      labelled === null
        ? ""
        : labelled
            .split(/\\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" ");
    const labelElement = labelFor(element);
    const label = labelElement ? renderedText(labelElement) : "";
    const own =
      labelledText ||
      element.getAttribute("aria-label") ||
      label ||
      element.getAttribute("alt") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      renderedText(element) ||
      "";
    return own.replace(/\\s+/g, " ").trim().slice(0, ${NAME_LIMIT});
  };
`;

/** Read native click listeners without patching the page's event APIs. */
const clickListenerPaths = async (page: Page): Promise<number[][]> => {
  const session = await page.context().newCDPSession(page);
  try {
    const documentObject = await session.send("Runtime.evaluate", {
      expression: "document",
    });
    const documentId = documentObject.result.objectId;
    if (documentId === undefined) {
      return [];
    }
    const { listeners } = await session.send("DOMDebugger.getEventListeners", {
      depth: -1,
      objectId: documentId,
    });
    const nodeIds = new Set<number>();
    for (const listener of listeners) {
      if (listener.type === "click" && listener.backendNodeId !== undefined) {
        nodeIds.add(listener.backendNodeId);
        if (nodeIds.size >= SNAPSHOT_LIMIT) {
          break;
        }
      }
    }
    const paths = await Promise.all(
      [...nodeIds].map(async (backendNodeId) => {
        try {
          const { object } = await session.send("DOM.resolveNode", {
            backendNodeId,
          });
          if (object.objectId === undefined) {
            return;
          }
          const { result } = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: `function() {
              const path = [];
              for (let node = this; node !== document.documentElement; node = node.parentElement) {
                if (!node?.parentElement) return null;
                path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
              }
              return path;
            }`,
            objectId: object.objectId,
            returnByValue: true,
          });
          const value: unknown = result.value;
          if (!Array.isArray(value) || !value.every(isIndex)) {
            return;
          }
          return value;
        } catch {
          // A listener may leave the document between discovery and resolve.
        }
      })
    );
    return paths.filter((path): path is number[] => path !== undefined);
  } finally {
    await session.detach();
  }
};

/**
 * What the Page is asked for. It collects the interactive controls, landmarks,
 * headings, and text a journey is described in — not the DOM — and hands back
 * the elements themselves so Contingency can mint references for them without
 * writing anything into the page under test.
 */
const SNAPSHOT_SCRIPT = (
  listenerPaths: readonly (readonly number[])[]
) => `(() => {${PAGE_READING_PRELUDE}
  const nativeClickTargets = new Set(
    ${JSON.stringify(listenerPaths)}.map((path) => {
      let element = document.documentElement;
      for (const index of path) {
        element = element?.children[index];
      }
      return element;
    }).filter(Boolean)
  );
  // React delegates native clicks to its root. Its handler is still attached
  // to the individual row through the DOM node's current props.
  const hasReactClick = (element) => Object.keys(element).some((key) =>
    key.startsWith("__reactProps$") &&
    typeof element[key]?.onClick === "function"
  );
  const reactClickTargets = new Set(
    Array.from(document.querySelectorAll("*")).filter(hasReactClick)
  );
  const delegatedClickTargets = new Set();
  for (const element of reactClickTargets) {
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (nativeClickTargets.has(ancestor)) {
        delegatedClickTargets.add(ancestor);
      }
    }
  }
  const isScriptedClick = (element) =>
    (nativeClickTargets.has(element) &&
      !delegatedClickTargets.has(element) &&
      !element.matches("html,body,main,nav") &&
      !element.querySelector("main,nav")) ||
    reactClickTargets.has(element);
  const isClickableRoot = (element) => {
    if (!isPointerRoot(element) && !isScriptedClick(element)) {
      return false;
    }
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (isPointerRoot(ancestor) || isScriptedClick(ancestor)) {
        return false;
      }
    }
    return true;
  };
  const itemContext = (element) => {
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      if (ancestor.matches("article,li,[role='listitem']")) {
        return ancestor;
      }
      if (ancestor.matches("main,nav,form")) {
        return null;
      }
      const siblings = ancestor.parentElement?.children;
      if (siblings && ancestor.classList.length > 0 && Array.from(siblings).some((sibling) =>
        sibling !== ancestor && sibling.tagName === ancestor.tagName &&
        Array.from(ancestor.classList).some((name) => sibling.classList.contains(name))
      )) {
        return ancestor;
      }
    }
    return null;
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
    if (isClickableRoot(element)) {
      clickable.add(element);
      controls.push(element);
      continue;
    }
    if (element.matches("img,[role='img'],[role='presentation'],[role='none']") &&
        accessibleName(element) === "") {
      continue;
    }
    // A label that names a control is already reported as that control's
    // name. Emitting it again leaves two nodes carrying the same text, and
    // the one that cannot be acted on listed first.
    if (element.tagName === "LABEL" && element.control) {
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
    if (element.matches(CONTROL_SELECTOR)) {
      const item = itemContext(element);
      if (item !== null) {
        node.context = redactSensitive(accessibleName(item));
      }
    }
    if (element.disabled === true) {
      node.disabled = true;
    }
    if (typeof element.checked === "boolean") {
      node.checked = element.checked;
    }
    if (typeof element.value === "string") {
      if (isSensitive(element)) {
        if (element.value.length > 0) {
          node.valueWithheld = true;
        }
      } else {
        node.value = element.value.slice(0, ${NAME_LIMIT});
      }
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

/**
 * Whether any element the Snapshot would report carries the phrase. A
 * done-when line is written from the semantic timeline, so it names elements
 * the way the Snapshot does — by accessible name, which for plain prose is
 * still its rendered text. Matching rendered text alone times out on a header
 * whose name comes from `aria-label`, on an element that is right there.
 */
const nameMatchScript = (phrase: string) => `(() => {${PAGE_READING_PRELUDE}
  const wanted = ${JSON.stringify(phrase)}.toLowerCase();
  for (const element of document.querySelectorAll("*")) {
    if (SKIPPED_TAGS.has(element.tagName) || !isVisible(element)) {
      continue;
    }
    const name = redactSensitive(accessibleName(element)).toLowerCase();
    if (name.includes(wanted)) {
      return true;
    }
  }
  return false;
})()`;

/** The page is untrusted, so everything it answers with is decoded on arrival. */
const CollectedNodes = Schema.Array(
  Schema.Struct({
    checked: Schema.optional(Schema.Boolean),
    clickable: Schema.optional(Schema.Boolean),
    context: Schema.optional(Schema.String),
    depth: Schema.Int,
    disabled: Schema.optional(Schema.Boolean),
    height: Schema.Finite,
    name: Schema.String,
    role: Schema.String,
    value: Schema.optional(Schema.String),
    valueWithheld: Schema.optional(Schema.Boolean),
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
/** One element the Snapshot located, with the box it occupied in the viewport. */
export interface AgentElementBounds {
  readonly rectangle: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly ref: AgentElementRef;
}

export interface AgentElementRegistry {
  /** Drop every reference, releasing the handles the browser still holds. */
  readonly clear: () => Effect.Effect<void>;
  /** Resolve a reference, or fail with a structured stale-reference error. */
  readonly resolve: (
    ref: string
  ) => Effect.Effect<ElementHandle, BrowserRpcErrorType>;
  /**
   * The role and accessible name the most recent Snapshot read for a
   * reference, so an action can be described by what it acted on rather than
   * by a reference that means nothing once the Snapshot is out of view.
   */
  readonly describe: (ref: string) => AgentActionSubject | undefined;
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
  /**
   * The same resolution with the bounds the Snapshot read, so a caller can
   * outline the element it hit rather than guess at where it sits.
   */
  readonly pointElement: (
    x: number,
    y: number
  ) => Effect.Effect<AgentElementBounds, BrowserRpcErrorType>;
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
  const subjects = new Map<string, AgentActionSubject>();
  const bounds = new Map<
    string,
    {
      /** The Snapshot that read this box, so hit-testing can prefer the newest. */
      readonly generation: number;
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
    subjects.clear();
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
      subjects.delete(ref);
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
      const listenerPaths = yield* Effect.tryPromise(() =>
        clickListenerPaths(page)
      ).pipe(Effect.orElseSucceed((): number[][] => []));
      const collected = yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          catch: (cause) => browserFailure("Could not read the Page", cause),
          try: () =>
            page.evaluateHandle<unknown>(SNAPSHOT_SCRIPT(listenerPaths)),
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
        bounds.set(ref, { generation, height, width, x, y });
        subjects.set(ref, { name: node.name, role: node.role });
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

  const pointElement = (
    x: number,
    y: number
  ): Effect.Effect<AgentElementBounds, BrowserRpcErrorType> => {
    const matches = [...bounds].filter(
      ([, rectangle]) =>
        x >= rectangle.x &&
        x <= rectangle.x + rectangle.width &&
        y >= rectangle.y &&
        y <= rectangle.y + rectangle.height
    );
    // References accumulate across Snapshots of one document, so a point can
    // sit inside a box an earlier Snapshot read. Only the newest Snapshot's
    // boxes still describe the Page, and only its nodes are listed in the tree
    // a caller records beside the hit, so a reference from any other
    // generation names a control that tree cannot resolve. A point the current
    // Snapshot does not cover is a miss, not an older match.
    const [closest] = matches
      .filter(([, rectangle]) => rectangle.generation === generation)
      .toSorted(
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
      : Effect.succeed({
          rectangle: {
            height: closest[1].height,
            width: closest[1].width,
            x: closest[1].x,
            y: closest[1].y,
          },
          ref: AgentElementRef.make(closest[0]),
        });
  };

  const pointRef = (
    x: number,
    y: number
  ): Effect.Effect<AgentElementRef, BrowserRpcErrorType> =>
    pointElement(x, y).pipe(Effect.map(({ ref }) => ref));

  return {
    clear,
    describe: (ref) => subjects.get(ref),
    focusedRef,
    isSensitive,
    pointElement,
    pointRef,
    privateSelector,
    resolve,
    snapshot,
  };
};

const REDACTED = "[sensitive input]";

export const redactKnownValues = (
  text: string,
  values: readonly string[]
): string => {
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
  nodes: snapshot.nodes.map((node) => {
    const redacted = {
      ...node,
      name: redactKnownValues(node.name, values),
    };
    if (node.value === undefined) {
      return redacted;
    }
    const value = redactControlValue(node.value, values);
    return value === node.value
      ? { ...redacted, value }
      : { ...redacted, value, valueWithheld: true };
  }),
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
                  const textParts: string[] = [];
                  for (const node of element.childNodes) {
                    if (node.nodeType === 3) {
                      textParts.push(node.textContent ?? "");
                    }
                  }
                  const ownText = textParts.join(" ");
                  return values.some((value) => ownText.includes(value))
                    ? [index]
                    : [];
                }),
              textValues
            );
      if (!maskSensitive) {
        return page.screenshot({ timeout: ACTION_TIMEOUT_MS, type: "png" });
      }
      return page.screenshot({
        mask: [
          page.locator(SENSITIVE_INPUT_SELECTOR),
          ...privateSelectors.map((selector) => page.locator(selector)),
          ...privateIndexes.map((index) => controls.nth(index)),
          ...privateTextIndexes.map((index) => textElements.nth(index)),
        ],
        maskColor: "#000000",
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

interface AnimationFramePageGlobals {
  readonly requestAnimationFrame: (callback: () => void) => number;
}

/** The in-page observer the probe scripts install; see PROBE_INSTALL_SCRIPT. */
interface PageActivityProbe {
  target?: unknown;
}

declare global {
  var requestAnimationFrame: AnimationFramePageGlobals["requestAnimationFrame"];
  var __contingencyPageActivity: PageActivityProbe | undefined;
}

/**
 * Wait out the navigation an action started, if it started one. A document
 * navigation destroys the execution context a read runs in, while a
 * same-document navigation keeps that context and commits its destination UI
 * on a following render.
 */
const settleNavigation = (page: Page, urlBefore: string): Effect.Effect<void> =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      if (page.url() === urlBefore) {
        await page.waitForLoadState("domcontentloaded", {
          timeout: SETTLE_TIMEOUT_MS,
        });
        return;
      }
      await page.waitForURL((url) => url.href !== urlBefore, {
        timeout: SETTLE_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      await page.evaluate(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame has no Promise API.
          new Promise<void>((resolve) => {
            globalThis.requestAnimationFrame(() => resolve());
          })
      );
      await page.evaluate(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- requestAnimationFrame has no Promise API.
          new Promise<void>((resolve) => {
            globalThis.requestAnimationFrame(() => resolve());
          })
      );
    },
  }).pipe(Effect.ignore);

/**
 * Read the Page after an action, once the navigation it started (if any) has
 * committed. If the read still lost a document-navigation race, settle and
 * read once more.
 */
export const snapshotAfterAction = (
  page: Page,
  registry: AgentElementRegistry,
  urlBefore: string
): Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType> => {
  const read = settleNavigation(page, urlBefore).pipe(
    Effect.andThen(() => registry.snapshot(page))
  );
  return read.pipe(Effect.catchCause(() => read));
};

/** The longest a read waits for the Page to go quiet. */
const QUIET_BOUND_MS = 2000;
/** How long the network must stay idle to count as quiet. */
const NETWORK_QUIET_MS = 500;
/** How long the document must stay unchanged to count as quiet. */
const DOM_QUIET_MS = 300;
const QUIET_POLL_MS = 50;

/**
 * Installs the in-page observer that counts what changes. It replaces any
 * earlier one, so a read abandoned mid-way leaves nothing behind it.
 */
const PROBE_INSTALL_SCRIPT = `(() => {
  const key = "__contingencyPageActivity";
  globalThis[key]?.disconnect();
  const state = {
    changes: 0,
    focus: document.activeElement,
    lastChangeAt: performance.now(),
    scrolls: 0,
    values: 0,
  };
  const touch = () => {
    state.lastChangeAt = performance.now();
  };
  const observer = new MutationObserver((records) => {
    state.changes += records.length;
    touch();
  });
  observer.observe(document, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  const onValue = () => {
    state.values += 1;
    touch();
  };
  const onScroll = () => {
    state.scrolls += 1;
    touch();
  };
  document.addEventListener("input", onValue, true);
  document.addEventListener("change", onValue, true);
  document.addEventListener("scroll", onScroll, true);
  state.disconnect = () => {
    observer.disconnect();
    document.removeEventListener("input", onValue, true);
    document.removeEventListener("change", onValue, true);
    document.removeEventListener("scroll", onScroll, true);
    delete globalThis[key];
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: state });
  return true;
})()`;

/** Reads the observer, or null when the document it watched is gone. */
const PROBE_READ_SCRIPT = `(() => {
  const state = globalThis.__contingencyPageActivity;
  if (state === undefined) {
    return null;
  }
  // Focus that lands on the element the action named is the action's own
  // mechanics, such as a click focusing its button, not the Page reacting.
  const active = document.activeElement;
  return {
    changes: state.changes,
    focusChanged: active !== state.focus && active !== state.target,
    quietForMs: performance.now() - state.lastChangeAt,
    scrolls: state.scrolls,
    values: state.values,
  };
})()`;

const PROBE_DISPOSE_SCRIPT = `(() => {
  globalThis.__contingencyPageActivity?.disconnect();
  return true;
})()`;

const ProbeReading = Schema.NullOr(
  Schema.Struct({
    changes: Schema.Number,
    focusChanged: Schema.Boolean,
    quietForMs: Schema.Number,
    scrolls: Schema.Number,
    values: Schema.Number,
  })
);
type ProbeValue = typeof ProbeReading.Type;

const installProbe = (page: Page): Effect.Effect<boolean> =>
  Effect.tryPromise(() => page.evaluate<unknown>(PROBE_INSTALL_SCRIPT)).pipe(
    Effect.map((installed) => installed === true),
    Effect.orElseSucceed(() => false)
  );

/** `undefined` when the Page could not be read at all, mid-navigation. */
const readProbe = (page: Page): Effect.Effect<ProbeValue | undefined> =>
  Effect.tryPromise(() => page.evaluate<unknown>(PROBE_READ_SCRIPT)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProbeReading)),
    Effect.orElseSucceed((): ProbeValue | undefined => undefined)
  );

const disposeProbe = (page: Page): Effect.Effect<void> =>
  Effect.tryPromise(() => page.evaluate<unknown>(PROBE_DISPOSE_SCRIPT)).pipe(
    Effect.ignore
  );

/**
 * What the Page looked like before an action, so the read after it can say
 * whether the action changed anything.
 */
export interface ActionObservation {
  readonly observed: boolean;
  readonly pagesBefore: ReadonlySet<Page>;
  readonly startedAt: number;
  readonly urlBefore: string;
}

/**
 * Start watching the Page for the effect of the action about to run, on the
 * element it names when it names one.
 */
export const beginActionObservation = (
  page: Page,
  target: Option.Option<ElementHandle>
): Effect.Effect<ActionObservation> =>
  Effect.gen(function* watchForActionEffect() {
    const urlBefore = page.url();
    const pagesBefore = new Set(page.context().pages());
    const observed = yield* installProbe(page);
    if (observed && Option.isSome(target)) {
      yield* Effect.tryPromise(() =>
        target.value.evaluate((element) => {
          const state = globalThis.__contingencyPageActivity;
          if (state !== undefined) {
            state.target = element;
          }
        })
      ).pipe(Effect.ignore);
    }
    return { observed, pagesBefore, startedAt: Date.now(), urlBefore };
  });

/** The element an action names, if it names one the registry still holds. */
export const actionTarget = (
  registry: AgentElementRegistry,
  action: AgentBrowserAction
): Effect.Effect<Option.Option<ElementHandle>> => {
  const ref = "ref" in action ? action.ref : undefined;
  return ref === undefined || ref === null
    ? Effect.succeedNone
    : Effect.option(registry.resolve(ref));
};

interface QuietReading {
  /** The document the observer watched was replaced while waiting. */
  readonly replaced: boolean;
  readonly reading: ProbeValue | undefined;
  readonly settle: AgentPageSettle;
}

/**
 * Wait, within a bound, for the network to go idle and the document to stop
 * changing. A Page that never goes quiet is reported as such rather than
 * waited on: polling and animation are ordinary, and the bound keeps them
 * from stalling every read.
 */
const awaitQuiet = (
  page: Page,
  since: number,
  observerInstalled: boolean
): Effect.Effect<QuietReading> =>
  Effect.gen(function* waitForQuietPage() {
    const deadline = Date.now() + QUIET_BOUND_MS;
    let installed = observerInstalled;
    let replaced = false;
    let reading: ProbeValue | undefined;
    let domSince = since;
    for (;;) {
      const current = installed ? yield* readProbe(page) : undefined;
      if (current === null || current === undefined) {
        // Either a new document, or one being replaced as it was read: the
        // one the action was observed in is gone, and the quiet wait starts
        // over for whatever replaces it.
        replaced ||= installed;
        installed = yield* installProbe(page);
        domSince = Date.now();
      } else if (!replaced) {
        reading = current;
      }
      const domQuiet =
        current === null || current === undefined
          ? 0
          : Math.min(current.quietForMs, Date.now() - domSince);
      const networkQuiet = networkQuietFor(page, since);
      const pending: AgentPageActivity[] = [];
      if (networkQuiet < NETWORK_QUIET_MS) {
        pending.push("network");
      }
      if (domQuiet < DOM_QUIET_MS) {
        pending.push("dom");
      }
      if (pending.length === 0 || Date.now() >= deadline) {
        yield* disposeProbe(page);
        return {
          reading,
          replaced,
          settle: { pending, settled: pending.length === 0 },
        };
      }
      yield* Effect.sleep(QUIET_POLL_MS);
    }
  });

const effectOf = (
  page: Page,
  observation: ActionObservation,
  quiet: QuietReading
): AgentActionEffect | null => {
  const signals: AgentActionSignal[] = [];
  if (page.url() !== observation.urlBefore) {
    signals.push("url");
  }
  if (
    page
      .context()
      .pages()
      .some((candidate) => !observation.pagesBefore.has(candidate))
  ) {
    signals.push("page");
  }
  const { reading } = quiet;
  if (
    quiet.replaced ||
    (reading !== null && reading !== undefined && reading.changes > 0)
  ) {
    signals.push("dom");
  }
  if (reading !== null && reading !== undefined) {
    if (reading.focusChanged) {
      signals.push("focus");
    }
    if (reading.values > 0) {
      signals.push("value");
    }
    if (reading.scrolls > 0) {
      signals.push("scroll");
    }
  }
  const [first, ...rest] = signals;
  if (first !== undefined) {
    return { kind: "observed", signals: [first, ...rest] };
  }
  // Without the in-page observer only a navigation or a new Page could have
  // shown an effect, so their absence proves nothing.
  return observation.observed && !quiet.replaced && reading !== undefined
    ? { kind: "none" }
    : null;
};

/**
 * Read the Page after an action once it has settled, and say what the action
 * was seen to change. The Snapshot carries whether the Page went quiet within
 * the bound, so a read taken while it was still busy is never mistaken for
 * the Page's final state.
 */
export const observeAfterAction = (
  page: Page,
  registry: AgentElementRegistry,
  observation: ActionObservation
): Effect.Effect<
  {
    readonly effect: AgentActionEffect | null;
    readonly snapshot: AgentBrowserSnapshot;
  },
  BrowserRpcErrorType
> =>
  Effect.gen(function* readSettledPageAfterAction() {
    yield* settleNavigation(page, observation.urlBefore);
    const quiet = yield* awaitQuiet(
      page,
      observation.startedAt,
      observation.observed
    );
    const effect = effectOf(page, observation, quiet);
    const read = registry.snapshot(page);
    const snapshot = yield* read.pipe(
      Effect.catchCause(() =>
        settleNavigation(page, observation.urlBefore).pipe(
          Effect.andThen(() => read)
        )
      )
    );
    return { effect, snapshot: { ...snapshot, settle: quiet.settle } };
  });

/**
 * Read the Page once it has settled, bounded, for an observation that follows
 * no action of its own.
 */
export const settledSnapshot = (
  page: Page,
  registry: AgentElementRegistry
): Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType> =>
  Effect.gen(function* readSettledPage() {
    const installed = yield* installProbe(page);
    const quiet = yield* awaitQuiet(page, 0, installed);
    const snapshot = yield* registry.snapshot(page);
    return { ...snapshot, settle: quiet.settle };
  });

const attempt = <A>(
  description: string,
  operation: () => Promise<A>
): Effect.Effect<A, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) => browserFailure(description, cause),
    try: operation,
  });

/** Resolve a reference and act on the element it still names, or fail. */
const onElement = <Success>(
  registry: AgentElementRegistry,
  ref: string,
  description: string,
  operation: (element: ElementHandle) => Promise<Success>
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
      // Matched against the accessible name the Browser Snapshot reports, not
      // against rendered text, so a phrase copied out of the timeline waits
      // for the element the timeline named.
      return attempt(`Could not find "${action.text}"`, async () => {
        const matched = await page.waitForFunction(
          nameMatchScript(action.text),
          undefined,
          { timeout: action.timeoutMs ?? ACTION_TIMEOUT_MS }
        );
        await matched.dispose();
      });
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
