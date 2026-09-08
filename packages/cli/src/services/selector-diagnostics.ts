import type {
  LocatorDescriptor,
  LocatorStrategy,
  NearbyElement,
  SelectorCandidate,
  SelectorDiagnostics,
} from "@contingency/protocol";
import { matchLocatorDescriptor } from "@contingency/protocol";
import { Effect, Function, Schema } from "effect";
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
 * How long a probe of the page may take, both for classifying a miss and for
 * reading the nearby elements. Short: the Step has already spent its own
 * timeout failing, and a diagnostic is not worth a second one.
 */
const PROBE_TIMEOUT_MS = 1000;

/** How Playwright reports a locator that names more than one element. */
const STRICT_MODE = "strict mode violation";

/** How Playwright reports the count behind a strict mode violation. */
const AMBIGUOUS_MATCHES = /resolved to (?<matches>\d+) elements/u;

/**
 * How Playwright words an element that went away mid-action, verified against
 * the installed version rather than remembered. If a future version rewords
 * it, this degrades gracefully: the miss falls through to the probe below and
 * is reported as unactionable with the browser's own words attached, which is
 * vaguer but never false.
 */
const DETACHED = "detached from the DOM";

/** How much of the browser's own wording a diagnostic carries. */
const DETAIL_LIMIT = 120;

/** Terminal styling Playwright may include in its call log. */
// oxlint-disable-next-line eslint/no-control-regex -- ANSI begins with ESC.
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;

/**
 * Playwright's own retry bookkeeping. These lines say the action was tried
 * again, never why it had to be — and they are what a call log ends on, so
 * taking the last line verbatim reports "waiting 500ms" and buries the
 * obstacle a few lines above it.
 */
const BOOKKEEPING = [
  /^waiting \d+ms$/u,
  /^(?:attempting|retrying) .* action$/u,
  /^waiting for (?:element|locator)\b/u,
  /^(?:scrolling into view if needed|done scrolling)$/u,
  /^element is visible, enabled and stable$/u,
];

/**
 * What the action was actually stuck on, in the browser's own words.
 *
 * The first line is only ever "Timeout 2000ms exceeded", which says nothing a
 * reader does not already know, so this reads the call log and takes the last
 * line that reports an obstacle rather than a retry. It filters the browser's
 * wording and never rewrites it: if every line looks like bookkeeping the last
 * one is quoted as-is, which is vaguer than it could be but never false.
 */
const obstacleLine = (message: string): string => {
  const lines = message
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replaceAll(ANSI_ESCAPE, "")
        .trim()
        .replace(/^-\s*/u, "")
        .replace(/^\d+ × /u, "")
    )
    .filter((line) => line.length > 0 && line !== "Call log:");
  const obstacles = lines.filter(
    (line) => !BOOKKEEPING.some((pattern) => pattern.test(line))
  );
  return (obstacles.at(-1) ?? lines.at(-1) ?? "").slice(0, DETAIL_LIMIT);
};

/** An optional field is absent rather than empty, which the schema refuses. */
const detailOf = (message: string): { detail?: string } => {
  const line = obstacleLine(message);
  return line.length === 0 ? {} : { detail: line };
};

/** The same, for the nearby elements a diagnostic may or may not have read. */
const nearestOf = (
  nearest: readonly NearbyElement[] | undefined
): { nearest?: readonly NearbyElement[] } =>
  nearest === undefined ? {} : { nearest };

/**
 * How a descriptor reads, and what it was searching for.
 *
 * One switch rather than two parallel ones: the phrase a reader sees and the
 * term the nearby elements are ranked against are two views of the same
 * descriptor, and splitting them was how they could drift apart.
 *
 * `phrase` leads with words wherever the strategy has any — role and name,
 * label, placeholder, text. CSS and XPath are paths by nature, so the phrase
 * names the strategy and then quotes the path rather than pretending to
 * paraphrase it.
 */
const readDescriptor = (
  descriptor: LocatorDescriptor
): { readonly phrase: string; readonly term: string } =>
  matchLocatorDescriptor(descriptor, {
    css: ({ selector }) => ({ phrase: `CSS ${selector}`, term: selector }),
    label: ({ label }) => ({ phrase: `label "${label}"`, term: label }),
    placeholder: ({ placeholder }) => ({
      phrase: `placeholder "${placeholder}"`,
      term: placeholder,
    }),
    role: ({ name, role }) => ({
      phrase: `role ${role} named "${name}"`,
      term: name,
    }),
    text: ({ text }) => ({ phrase: `text "${text}"`, term: text }),
    xpath: ({ expression }) => ({
      phrase: `XPath ${expression}`,
      term: expression,
    }),
  });

/** How a descriptor reads in a failure message: words before raw paths. */
export const describeLocator = (descriptor: LocatorDescriptor): string =>
  readDescriptor(descriptor).phrase;

/**
 * What a miss reads as, once a reader has the candidate in front of them.
 *
 * Every kind is listed rather than leaning on a default: a sixth kind added to
 * the schema should fail to compile here, not quietly inherit the wording of
 * whichever one the default happened to describe.
 */
const describeMiss = (candidate: SelectorCandidate): string => {
  switch (candidate.miss) {
    case "absent": {
      return "nothing matched";
    }
    case "ambiguous": {
      // An unknown count is said as one. "0 elements matched" would be both
      // false and the exact opposite of what ambiguous means.
      return candidate.matches === undefined
        ? "several elements matched, so the Flow does not say which"
        : `${candidate.matches} elements matched, so the Flow does not say which`;
    }
    case "hidden": {
      return "matched, but not visible";
    }
    case "detached": {
      return "matched, but detached from the page";
    }
    case "unactionable": {
      return "matched, but would not accept the action";
    }
    default: {
      throw new Error("Unknown miss kind.");
    }
  }
};

type Miss = Pick<SelectorCandidate, "detail" | "matches" | "miss">;

/**
 * Why this candidate missed, asked of the page rather than inferred from the
 * browser's message wherever the page can answer.
 *
 * Two answers come from the failure itself, because the page can no longer be
 * asked about them after the fact: a strict mode violation carries its own
 * count, and an element that went away mid-action has already gone — probing
 * afterwards finds it back again, present and visible, and would report the
 * flapping element as merely unactionable.
 *
 * Everything else is measured. This effect fails when the page cannot answer,
 * which is deliberate: see {@link missedCandidate}.
 */
const classifyMiss = (
  locator: Locator,
  cause: unknown
): Effect.Effect<Miss, unknown> => {
  const message = cause instanceof Error ? cause.message : String(cause);
  // Gated on the violation itself, not on the phrase alone: a call log can
  // quote how many elements a locator resolved to for reasons that have
  // nothing to do with ambiguity, and reading a count out of one of those
  // would report a miss the page never made.
  const counted = message.includes(STRICT_MODE)
    ? Number(AMBIGUOUS_MATCHES.exec(message)?.groups?.["matches"])
    : Number.NaN;
  if (Number.isInteger(counted)) {
    return Effect.succeed({ matches: counted, miss: "ambiguous" });
  }
  if (message.includes(DETACHED)) {
    // No detail: "matched, but detached from the page" already says it, and a
    // redundant quote is noise in every artifact that carries it.
    return Effect.succeed({ miss: "detached" });
  }
  return Effect.tryPromise(async (): Promise<Miss> => {
    const matches = await locator.count();
    if (matches === 0) {
      return { miss: "absent" };
    }
    if (matches > 1) {
      return { matches, miss: "ambiguous" };
    }
    // No timeout option: `isVisible` is documented as returning immediately
    // and ignoring one, so passing it would only look like a wait.
    const visible = await locator.first().isVisible();
    if (!visible) {
      return { miss: "hidden" };
    }
    // Matched, present, and visible: the browser refused for some other
    // reason, and its own words are the honest answer rather than a guess
    // dressed up as one of the four.
    return { ...detailOf(message), miss: "unactionable" };
  }).pipe(
    // A real bound rather than the one `isVisible` documents as ignored. A
    // page that cannot answer a count in a second is wedged, and this failing
    // stops the Run rather than inventing a miss for it.
    Effect.timeout(PROBE_TIMEOUT_MS)
  );
};

/**
 * One candidate's record: what it looked for, and what the page answered.
 *
 * Fails when the page could not be asked. A miss is a claim about the site —
 * that it no longer has what the Flow named — and a claim nobody verified must
 * not be recorded as one. A session that died between the miss and the probe
 * would otherwise be filed as an absence, which is precisely the
 * misattribution the ladder's own guard exists to prevent, one step later.
 */
export const missedCandidate = Effect.fn("SelectorDiagnostics.missedCandidate")(
  function* recordMissedCandidate(
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
      const terms = target.map((descriptor) => readDescriptor(descriptor).term);
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
    // The page could not be read, which is not the same as reading an empty
    // one, and unlike a miss it claims nothing about the site either way.
    Effect.orElseSucceed(Function.constUndefined)
  );

/** Everything a resolution failure knows, gathered once the ladder is spent. */
export const selectorDiagnostics = Effect.fn("SelectorDiagnostics.gather")(
  function* gatherDiagnostics(
    page: Page,
    target: readonly LocatorDescriptor[],
    candidates: readonly SelectorCandidate[]
  ) {
    const nearest = yield* nearestElements(page, target);
    return { candidates, ...nearestOf(nearest) } satisfies SelectorDiagnostics;
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
  candidates: diagnostics.candidates.map((candidate) => {
    const redacted = {
      ...candidate,
      lookedFor: redactSecrets(candidate.lookedFor, variables),
    };
    return candidate.detail === undefined
      ? redacted
      : { ...redacted, detail: redactSecrets(candidate.detail, variables) };
  }),
  ...nearestOf(
    diagnostics.nearest?.map((element) => ({
      ...element,
      name: redactSecrets(element.name, variables),
    }))
  ),
});
