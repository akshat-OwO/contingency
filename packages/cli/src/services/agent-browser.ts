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
  SENSITIVE_FIELD_METADATA,
  SENSITIVE_FIELD_TERMS,
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

/** Inputs whose values are never copied into a Browser Snapshot. */
const SENSITIVE_INPUT_SELECTOR = [
  '[type="password" i]',
  '[autocomplete^="current-password"]',
  '[autocomplete^="new-password"]',
  '[autocomplete="one-time-code"]',
  '[autocomplete^="cc-"]',
  ...SENSITIVE_FIELD_TERMS.flatMap((term) => [
    `[name*="${term}" i]`,
    `[id*="${term}" i]`,
    `[aria-label*="${term}" i]`,
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
  // Markup that declares itself a control or a landmark. An SPA row that
  // carries its handler in script matches none of this, so it is found by
  // cursor instead.
  const DECLARED_SELECTOR =
    "a[href],button,input,select,textarea,summary,[role],[onclick]," +
    "[tabindex],[contenteditable=''],[contenteditable='true']," +
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
    const metadata = [
      element.getAttribute("name"),
      element.getAttribute("id"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
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
      looksLikeUnlabelledCode
    );
  };
  const sensitiveValues = Array.from(
    document.querySelectorAll('input,textarea,select,[role="textbox"]')
  )
    .filter(isSensitive)
    .map((element) => element.value)
    .filter((value) => typeof value === "string" && value.length > 0);
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
  const declared = [];
  const clickable = new Set();
  const textual = [];
  for (const element of document.querySelectorAll("*")) {
    if (SKIPPED_TAGS.has(element.tagName) || !isVisible(element)) {
      continue;
    }
    if (element.matches(DECLARED_SELECTOR)) {
      declared.push(element);
      continue;
    }
    if (isPointerRoot(element)) {
      clickable.add(element);
      declared.push(element);
      continue;
    }
    if (ownsText(element)) {
      textual.push(element);
    }
  }
  const textBudget = Math.max(0, ${SNAPSHOT_LIMIT} - declared.length);
  const kept = new Set(declared);
  for (const element of textual.slice(0, textBudget)) {
    kept.add(element);
  }
  const candidates = [];
  for (const element of document.querySelectorAll("*")) {
    if (candidates.length >= ${SNAPSHOT_LIMIT}) {
      break;
    }
    if (kept.has(element)) {
      candidates.push(element);
    }
  }
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
    const node = { depth: Math.min(depth, 64), name, role };
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
  return { elements, nodes, title: document.title, url: location.href };
})()`;

/** The page is untrusted, so everything it answers with is decoded on arrival. */
const CollectedNodes = Schema.Array(
  Schema.Struct({
    checked: Schema.optional(Schema.Boolean),
    clickable: Schema.optional(Schema.Boolean),
    depth: Schema.Int,
    disabled: Schema.optional(Schema.Boolean),
    name: Schema.String,
    role: Schema.String,
    value: Schema.optional(Schema.String),
  })
);
const CollectedPage = Schema.Struct({
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
  /** Read the Page and mint a new generation of references for it. */
  readonly snapshot: (
    page: Page
  ) => Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType>;
}

export const makeAgentElementRegistry = (
  now: () => Date = () => new Date()
): AgentElementRegistry => {
  const elements = new Map<string, ElementHandle>();
  let generation = 0;
  /** Never reset: a reference names one element of one Snapshot, forever. */
  let minted = 0;
  /** The document the live references were read in. */
  let documentUrl: string | undefined;

  const clear = (): Effect.Effect<void> => {
    const handles = [...elements.values()];
    elements.clear();
    documentUrl = undefined;
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
            const rawPage = yield* Effect.tryPromise({
              catch: (cause) =>
                browserFailure("Could not read the Browser Snapshot", cause),
              try: async () => ({
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
      ).pipe(Effect.orElseSucceed(() => ({ title: "", url: page.url() })));
      const nodes: AgentSnapshotNode[] = [];
      const orphaned: JSHandle<unknown>[] = [];
      let index = 0;
      for (const [, entry] of collected.handles) {
        const element = entry.asElement();
        const node = decodedNodes[index];
        index += 1;
        if (element === null || node === undefined) {
          orphaned.push(entry);
          continue;
        }
        minted += 1;
        const ref = AgentElementRef.make(`e${minted}`);
        elements.set(ref, element);
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
            element.evaluate((candidate) => {
              const metadata = [
                candidate.getAttribute("name"),
                candidate.getAttribute("id"),
                candidate.getAttribute("aria-label"),
              ]
                .filter(Boolean)
                .join(" ");
              const autocomplete = candidate.getAttribute("autocomplete") ?? "";
              const inputMode = candidate
                .getAttribute("inputmode")
                ?.toLowerCase();
              const maxLength = Number(candidate.getAttribute("maxlength"));
              const sensitiveMetadata =
                /(?:token|key|secret|code|password|credential|passcode|pin|otp|one[\s_-]?time|cvv|cvc|social[\s_-]?security|ssn)/iu;
              const sensitiveAutocomplete =
                /^(?:current-password|new-password|one-time-code|cc-)/iu;
              const looksLikeUnlabelledCode =
                (inputMode === "numeric" || inputMode === "decimal") &&
                Number.isInteger(maxLength) &&
                maxLength >= 4 &&
                maxLength <= 8;
              return (
                candidate.getAttribute("type")?.toLowerCase() === "password" ||
                sensitiveAutocomplete.test(autocomplete) ||
                sensitiveMetadata.test(metadata) ||
                looksLikeUnlabelledCode
              );
            }),
        })
      )
    );

  return { clear, isSensitive, resolve, snapshot };
};

export const captureAgentScreenshot = (
  page: Page,
  now: () => Date = () => new Date(),
  maskSensitive = false
): Effect.Effect<AgentScreenshot, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) => browserFailure("Could not capture a screenshot", cause),
    try: () =>
      page.screenshot({
        ...(maskSensitive
          ? {
              mask: [page.locator(SENSITIVE_INPUT_SELECTOR)],
              maskColor: "#000000",
            }
          : {}),
        timeout: ACTION_TIMEOUT_MS,
        type: "png",
      }),
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
 * Read the Page after an action. An action that navigates destroys the
 * execution context the Snapshot script runs in, so the read waits for the new
 * document and, if it still lost the race, settles and reads once more. Without
 * this, a Press that submits a form is recorded as failed although it worked.
 */
export const snapshotAfterAction = (
  page: Page,
  registry: AgentElementRegistry
): Effect.Effect<AgentBrowserSnapshot, BrowserRpcErrorType> => {
  const settle = Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      page.waitForLoadState("domcontentloaded", {
        timeout: SETTLE_TIMEOUT_MS,
      }),
  }).pipe(Effect.ignore);
  const read = settle.pipe(Effect.andThen(() => registry.snapshot(page)));
  return read.pipe(Effect.catchCause(() => read));
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
