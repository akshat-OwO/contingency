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
  const SELECTOR =
    "a[href],button,input,select,textarea,summary,[role],[onclick]," +
    "h1,h2,h3,h4,h5,h6,main,nav,header,footer,form,li,td,th,p,label,img";
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
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
  const candidates = Array.from(document.querySelectorAll(SELECTOR))
    .filter(isVisible)
    .slice(0, ${SNAPSHOT_LIMIT});
  const included = new Set(candidates);
  const elements = [];
  const nodes = [];
  for (const element of candidates) {
    const isInput = element.tagName === "INPUT";
    const tagRole = isInput
      ? INPUT_ROLES[element.type] || "textbox"
      : ROLE_BY_TAG[element.tagName] || element.tagName.toLowerCase();
    const role = element.getAttribute("role") || tagRole;
    const name = accessibleName(element);
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
    if (element.disabled === true) {
      node.disabled = true;
    }
    if (typeof element.checked === "boolean") {
      node.checked = element.checked;
    }
    if (typeof element.value === "string" && element.type !== "password") {
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
        url: identity.url,
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

  return { clear, resolve, snapshot };
};

export const captureAgentScreenshot = (
  page: Page,
  now: () => Date = () => new Date()
): Effect.Effect<AgentScreenshot, BrowserRpcErrorType> =>
  Effect.tryPromise({
    catch: (cause) => browserFailure("Could not capture a screenshot", cause),
    try: () => page.screenshot({ timeout: ACTION_TIMEOUT_MS, type: "png" }),
  }).pipe(
    Effect.map((image) => ({
      capturedAt: now().toISOString(),
      encoding: "base64" as const,
      format: "png" as const,
      image: image.toString("base64"),
      url: page.url(),
    }))
  );

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
      return attempt(`Could not navigate to ${action.url}`, () =>
        page.goto(action.url, { timeout: ACTION_TIMEOUT_MS })
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
        ? attempt(`Could not press ${action.key}`, () =>
            page.keyboard.press(action.key)
          )
        : onElement(
            registry,
            ref,
            `Could not press ${action.key} on ${ref}`,
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
