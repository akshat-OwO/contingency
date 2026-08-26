import type {
  LocatorDescriptor,
  LocatorMiss,
  LocatorStrategy,
  NearbyElement,
  SelectorCandidate,
  SelectorDiagnostics,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";
import type { Locator, Page } from "playwright-core";

import { redactSecrets } from "./variables.ts";
import type { VariableResolution } from "./variables.ts";

/**
 * Why a Step could not find its element, told candidate by candidate.
 *
 * The previous runtime kept only the last candidate's message and surfaced the
 * browser tool's raw string, so a failure showed one XPath dump and discarded
 * the other half of the evidence (ADR 0012). Everything here exists to make a
 * stale Flow readable without re-running it: what each alternative looked for,
 * why each missed, and what the page actually had instead.
 *
 * Every string that reaches a Run passes through {@link redactDiagnostics}
 * first. A diagnostic reports what it found on the page, and a page mid-Flow
 * holds whatever a Variable typed into it.
 */

/** How many nearby elements a failure lists. Enough to spot a rename. */
const NEAREST_LIMIT = 8;

/** How many elements the page is asked to consider before ranking. */
const NEAREST_SCAN_LIMIT = 400;

/** How much of an element's name a diagnostic carries. */
const NEAREST_NAME_LIMIT = 80;

/**
 * How long a post-miss probe of the page may take. Short: the Step has already
 * spent its own timeout failing, and a diagnostic is not worth a second one.
 */
const PROBE_TIMEOUT_MS = 1000;

/** How Playwright reports the count behind a strict mode violation. */
const AMBIGUOUS_MATCHES = /resolved to (?<matches>\d+) elements/u;

/** The first line of a browser message, without its call log. */
const firstLine = (message: string): string =>
  message.split("\n")[0]?.trim() ?? "";

/** An optional field is absent rather than empty, which the schema refuses. */
const detailOf = (message: string): { detail?: string } => {
  const line = firstLine(message);
  return line.length === 0 ? {} : { detail: line };
};

/** How a descriptor reads in a failure message: words before raw paths. */
export const describeLocator = (descriptor: LocatorDescriptor): string => {
  switch (descriptor.kind) {
    case "role": {
      return `role ${descriptor.role} named "${descriptor.name}"`;
    }
    case "label": {
      return `label "${descriptor.label}"`;
    }
    case "placeholder": {
      return `placeholder "${descriptor.placeholder}"`;
    }
    case "text": {
      return `text "${descriptor.text}"`;
    }
    case "css": {
      return `CSS ${descriptor.selector}`;
    }
    case "xpath": {
      return `XPath ${descriptor.expression}`;
    }
    default: {
      throw new Error("Unknown locator descriptor.");
    }
  }
};

/** The words a descriptor searched for, used to rank what the page did have. */
const searchTerm = (descriptor: LocatorDescriptor): string => {
  switch (descriptor.kind) {
    case "role": {
      return descriptor.name;
    }
    case "label": {
      return descriptor.label;
    }
    case "placeholder": {
      return descriptor.placeholder;
    }
    case "text": {
      return descriptor.text;
    }
    case "css": {
      return descriptor.selector;
    }
    case "xpath": {
      return descriptor.expression;
    }
    default: {
      throw new Error("Unknown locator descriptor.");
    }
  }
};

/** What a miss reads as, once a reader has the candidate in front of them. */
const describeMiss = (candidate: SelectorCandidate): string => {
  switch (candidate.miss) {
    case "absent": {
      return "nothing matched";
    }
    case "ambiguous": {
      return `${candidate.matches ?? 0} elements matched, so the Flow does not say which`;
    }
    case "hidden": {
      return "matched, but not visible";
    }
    case "detached": {
      return "matched, but detached from the page";
    }
    default: {
      return "matched, but would not accept the action";
    }
  }
};

type Miss = Pick<SelectorCandidate, "detail" | "matches" | "miss">;

/**
 * Why this candidate missed, asked of the page rather than inferred from the
 * browser's message. A strict mode violation already carries its own count; a
 * timeout says only that the wait ran out, so the page is counted and checked.
 *
 * Never fails: a diagnostic that cannot be gathered must not replace the
 * failure it was describing.
 */
const classifyMiss = (
  locator: Locator,
  cause: unknown
): Effect.Effect<Miss> => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const ambiguous = AMBIGUOUS_MATCHES.exec(message);
  const counted = Number(ambiguous?.groups?.["matches"]);
  if (Number.isInteger(counted)) {
    return Effect.succeed({ matches: counted, miss: "ambiguous" });
  }
  return Effect.tryPromise(async (): Promise<Miss> => {
    const matches = await locator.count();
    if (matches === 0) {
      return { miss: "absent" };
    }
    if (matches > 1) {
      return { matches, miss: "ambiguous" };
    }
    const visible = await locator
      .first()
      .isVisible({ timeout: PROBE_TIMEOUT_MS });
    if (!visible) {
      return { miss: "hidden" };
    }
    // Matched, present, and visible: the browser refused for some other
    // reason, and its own words are the honest answer rather than a guess
    // dressed up as one of the four.
    return { ...detailOf(message), miss: "unactionable" };
  }).pipe(
    Effect.orElseSucceed((): Miss => {
      // The page could not be counted, so the miss is what the browser said
      // rather than what was measured.
      const miss: LocatorMiss = message.includes("not attached")
        ? "detached"
        : "absent";
      return { ...detailOf(message), miss };
    })
  );
};

/** One candidate's record: what it looked for, and what the page answered. */
export const missedCandidate = Effect.fn("Runner.missedCandidate")(
  function* missedCandidate(
    descriptor: LocatorDescriptor,
    locator: Locator,
    cause: unknown
  ) {
    const classified = yield* classifyMiss(locator, cause);
    return {
      ...classified,
      lookedFor: describeLocator(descriptor),
      // The descriptor kinds are the strategy names, so the descriptor
      // already carries it.
      strategy: descriptor.kind satisfies LocatorStrategy,
    } satisfies SelectorCandidate;
  }
);

const bigrams = (value: string): string[] => {
  const normalized = value.toLowerCase().replaceAll(/\s+/gu, " ").trim();
  return Array.from({ length: Math.max(normalized.length - 1, 0) }, (_, at) =>
    normalized.slice(at, at + 2)
  );
};

/**
 * Bigram overlap, so a button renamed "Place your order" ranks above an
 * unrelated link when the Flow was looking for "Place order". Cheap and good
 * enough to order a list of eight; nothing downstream depends on the score.
 */
const similarity = (left: string, right: string): number => {
  const source = bigrams(left);
  const other = bigrams(right);
  if (source.length === 0 || other.length === 0) {
    return 0;
  }
  const pool = [...other];
  let shared = 0;
  for (const gram of source) {
    const at = pool.indexOf(gram);
    if (at !== -1) {
      pool.splice(at, 1);
      shared += 1;
    }
  }
  return (2 * shared) / (source.length + other.length);
};

/**
 * Read in the page rather than through Playwright's accessibility snapshot:
 * the snapshot is a tree of every node, and what a failure needs is a short
 * flat list of the named things a person could have been aiming at.
 *
 * A page script rather than a typed closure, matching how every other in-page
 * script here is written: this package compiles without the DOM library, and
 * the page's answer is untrusted either way and decoded on arrival.
 */
const NEAREST_ELEMENTS_SCRIPT = `(() => {
  const ROLE_BY_TAG = {
    A: "link",
    BUTTON: "button",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    LABEL: "label",
    SELECT: "combobox",
    SUMMARY: "button",
    TEXTAREA: "textbox",
  };
  const INPUT_ROLES = {
    button: "button",
    checkbox: "checkbox",
    radio: "radio",
    search: "searchbox",
    submit: "button",
  };
  const found = [];
  const seen = new Set();
  const candidates = document.querySelectorAll(
    "a[href],button,input,select,textarea,summary,label,[role],h1,h2,h3,h4,h5,h6"
  );
  for (const element of Array.from(candidates).slice(0, ${NEAREST_SCAN_LIMIT})) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const isInput = element.tagName === "INPUT";
    const tagRole = isInput
      ? INPUT_ROLES[element.type] || "textbox"
      : ROLE_BY_TAG[element.tagName] || element.tagName.toLowerCase();
    const role = element.getAttribute("role") || tagRole;
    const attributeName = (
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      ""
    ).trim();
    // Escaped twice: this is a template literal, so the page receives \\s.
    const text = (element.textContent || "").replace(/\\s+/g, " ").trim();
    const name = (attributeName || text).slice(0, ${NEAREST_NAME_LIMIT});
    if (name.length === 0) {
      continue;
    }
    const key = role + " " + name;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({ name, role });
  }
  return found;
})()`;

/** The page is untrusted, so what it answers with is decoded before it is read. */
const CollectedElements = Schema.Array(
  Schema.Struct({ name: Schema.String, role: Schema.String })
);

/** The page could not be read, which is not the same as reading an empty one. */
const noElements = (): readonly NearbyElement[] | undefined => undefined;

/**
 * The nearest elements the page actually had, ranked against what the Step was
 * looking for, so a renamed button is visibly a rename rather than a removal.
 *
 * `undefined` means the page could not be read — a closed page, a navigation
 * mid-flight — which is not the same as a page that had nothing to report.
 */
const nearestElements = (
  page: Page,
  target: readonly LocatorDescriptor[]
): Effect.Effect<readonly NearbyElement[] | undefined> =>
  Effect.tryPromise(() => page.evaluate<unknown>(NEAREST_ELEMENTS_SCRIPT)).pipe(
    Effect.flatMap((collected) =>
      Schema.decodeUnknownEffect(CollectedElements)(collected)
    ),
    Effect.timeout(PROBE_TIMEOUT_MS),
    Effect.map((elements) => {
      const terms = target.map(searchTerm);
      return elements
        .map((element) => ({
          element,
          score: Math.max(
            0,
            ...terms.map((term) => similarity(term, element.name))
          ),
        }))
        .toSorted((left, right) => right.score - left.score)
        .slice(0, NEAREST_LIMIT)
        .map(({ element }) => element);
    }),
    Effect.orElseSucceed(noElements)
  );

/** Everything a resolution failure knows, gathered once the ladder is spent. */
export const selectorDiagnostics = Effect.fn("Runner.selectorDiagnostics")(
  function* gatherDiagnostics(
    page: Page,
    target: readonly LocatorDescriptor[],
    candidates: readonly SelectorCandidate[]
  ) {
    const nearest = yield* nearestElements(page, target);
    return {
      candidates,
      ...(nearest === undefined ? {} : { nearest }),
    } satisfies SelectorDiagnostics;
  }
);

/** The same evidence as a sentence, for a reader who only sees the message. */
export const describeDiagnostics = (
  diagnostics: SelectorDiagnostics
): string => {
  const tried = diagnostics.candidates
    .map((candidate) => `${candidate.lookedFor} — ${describeMiss(candidate)}`)
    .join("; ");
  const nearest = diagnostics.nearest ?? [];
  const present =
    nearest.length === 0
      ? ""
      : ` Nearest elements present: ${nearest
          .map((element) => `${element.role} "${element.name}"`)
          .join("; ")}.`;
  return `Could not resolve this Step's target (tried ${diagnostics.candidates.length}): ${tried}.${present}`;
};

/**
 * Scrub every secret value out of a diagnostic. A candidate's `lookedFor` can
 * carry a Variable a Step substituted, and a nearby element's name is whatever
 * the page was showing — including the value a previous Step typed into it.
 */
export const redactDiagnostics = (
  diagnostics: SelectorDiagnostics,
  variables: VariableResolution
): SelectorDiagnostics => ({
  candidates: diagnostics.candidates.map((candidate) => ({
    ...candidate,
    ...(candidate.detail === undefined
      ? {}
      : { detail: redactSecrets(candidate.detail, variables) }),
    lookedFor: redactSecrets(candidate.lookedFor, variables),
  })),
  ...(diagnostics.nearest === undefined
    ? {}
    : {
        nearest: diagnostics.nearest.map((element) => ({
          ...element,
          name: redactSecrets(element.name, variables),
        })),
      }),
});
