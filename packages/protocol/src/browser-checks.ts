import { Predicate, Schema } from "effect";

import { optionalNullable } from "./optional-field.ts";
import { httpOriginFromUrl } from "./storage.ts";

const text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048)
);
export const BrowserFieldPath = Schema.Array(
  Schema.Union([text, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))])
).check(Schema.isMaxLength(32));
export const BrowserPredicate = Schema.Struct({
  expected: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isMaxLength(2048)),
      Schema.Finite,
      Schema.Boolean,
      Schema.Null,
    ])
  ),
  id: Schema.optionalKey(text),
  operator: Schema.Literals([
    "exists",
    "equals",
    "contains",
    "gt",
    "gte",
    "lt",
    "lte",
  ]),
  path: BrowserFieldPath,
});
export type BrowserPredicate = typeof BrowserPredicate.Type;
export const BrowserExpectation = Schema.Struct({
  /** A wildcard selects an unordered array item. All predicates apply to that same item. */
  itemPath: BrowserFieldPath,
  predicates: Schema.Array(BrowserPredicate).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20)
  ),
});
export type BrowserExpectation = typeof BrowserExpectation.Type;
export const BrowserRequestPattern = Schema.Struct({
  method: text,
  origin: text,
  /** Colon-prefixed segments match one explicitly variable segment. */
  path: text,
  query: Schema.Record(
    text,
    Schema.String.check(Schema.isMaxLength(2048))
  ).check(Schema.isMaxProperties(20)),
});
export type BrowserRequestPattern = typeof BrowserRequestPattern.Type;
const checkFields = {
  demonstrated: Schema.Boolean,
  id: text,
  timeoutMs: Schema.Int.check(
    Schema.isBetween({ maximum: 60_000, minimum: 1 })
  ),
  when: text,
};
export const BrowserCheck = Schema.Union([
  Schema.Struct({
    ...checkFields,
    expectation: BrowserExpectation,
    kind: Schema.Literal("response"),
    request: BrowserRequestPattern,
    response: Schema.Literals(["matching", "first"]),
  }),
  Schema.Struct({
    ...checkFields,
    change: Schema.Literals(["current", "created", "changed"]),
    cookiePath: optionalNullable(text),
    expectation: BrowserExpectation,
    kind: Schema.Literals(["cookie", "local", "session"]),
    name: text,
    origin: text,
  }),
]);
export type BrowserCheck = typeof BrowserCheck.Type;
export const BrowserCheckReference = Schema.Struct({
  check: BrowserCheck,
  flowSkillName: text,
});
export type BrowserCheckReference = typeof BrowserCheckReference.Type;
export const BrowserCheckIdentity = Schema.Struct({
  flowSkillName: text,
  id: text,
});
export type BrowserCheckIdentity = typeof BrowserCheckIdentity.Type;
export const BrowserCheckResult = Schema.Struct({
  ...BrowserCheckIdentity.fields,
  at: text,
  operationId: text,
  status: Schema.Literals(["passed", "failed", "inconclusive", "interrupted"]),
  summary: text,
});
export type BrowserCheckResult = typeof BrowserCheckResult.Type;
export const TeachingBrowserAttachment = Schema.Struct({
  candidate: BrowserCheck,
  id: text,
  label: text,
  /** Context never constrains Run success. A check is explicit authoring intent. */
  requirement: optionalNullable(BrowserCheck),
});
export type TeachingBrowserAttachment = typeof TeachingBrowserAttachment.Type;
export const browserAttachmentsField = optionalNullable(
  Schema.Array(TeachingBrowserAttachment).check(Schema.isMaxLength(50))
);
export const browserCheckIdsField = optionalNullable(
  Schema.Array(BrowserCheckIdentity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50)
  )
);
export const browserCheckRequirementsField = Schema.optionalKey(
  Schema.Array(BrowserCheckReference).check(Schema.isMaxLength(100))
);
export const browserCheckResultsField = Schema.optionalKey(
  Schema.Array(BrowserCheckResult)
);

export const BrowserDiagnostics = Schema.Struct({
  console: Schema.Array(
    Schema.Struct({ level: text, text: Schema.Literal("[content withheld]") })
  ),
  network: Schema.Array(
    Schema.Struct({
      method: text,
      origin: text,
      path: text,
      status: Schema.NullOr(Schema.Int),
    })
  ),
  storage: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["cookie", "local", "session"]),
      name: text,
      value: Schema.Literal("[value withheld]"),
    })
  ),
  truncated: Schema.Boolean,
});
export type BrowserDiagnostics = typeof BrowserDiagnostics.Type;

const isJsonObject = (
  value: Schema.Json | undefined
): value is Schema.JsonObject => Predicate.isObject(value);
const readField = (
  value: Schema.Json | undefined,
  key: string | number
): Schema.Json | undefined => {
  if (Predicate.isNumber(key)) {
    return Array.isArray(value) ? value[key] : undefined;
  }
  return isJsonObject(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
};
const select = (
  value: Schema.Json | undefined,
  path: readonly (string | number)[]
): readonly (Schema.Json | undefined)[] => {
  if (path.length === 0) {
    return [value];
  }
  const [key, ...rest] = path;
  if (key === "*") {
    return Array.isArray(value)
      ? value.flatMap((item: Schema.Json) => select(item, rest))
      : [];
  }
  return key === undefined ? [] : select(readField(value, key), rest);
};
const matchesPredicate = (
  value: Schema.Json | undefined,
  predicate: BrowserPredicate
): boolean =>
  select(value, predicate.path).some((actual) => {
    switch (predicate.operator) {
      case "exists": {
        return actual !== undefined;
      }
      case "equals": {
        return actual !== undefined && actual === predicate.expected;
      }
      case "contains": {
        return (
          Predicate.isString(actual) &&
          Predicate.isString(predicate.expected) &&
          actual.includes(predicate.expected)
        );
      }
      case "gt": {
        return (
          Predicate.isNumber(actual) &&
          Predicate.isNumber(predicate.expected) &&
          actual > predicate.expected
        );
      }
      case "gte": {
        return (
          Predicate.isNumber(actual) &&
          Predicate.isNumber(predicate.expected) &&
          actual >= predicate.expected
        );
      }
      case "lt": {
        return (
          Predicate.isNumber(actual) &&
          Predicate.isNumber(predicate.expected) &&
          actual < predicate.expected
        );
      }
      case "lte": {
        return (
          Predicate.isNumber(actual) &&
          Predicate.isNumber(predicate.expected) &&
          actual <= predicate.expected
        );
      }
      default: {
        return false;
      }
    }
  });
export const matchesBrowserExpectation = (
  value: Schema.Json | undefined,
  expectation: BrowserExpectation
): boolean =>
  select(value, expectation.itemPath).some((item) =>
    expectation.predicates.every((predicate) =>
      matchesPredicate(item, predicate)
    )
  );
export const matchesBrowserRequest = (
  method: string,
  url: string,
  pattern: BrowserRequestPattern
): boolean => {
  try {
    const actual = httpOriginFromUrl(url);
    if (actual === undefined) {
      return false;
    }
    const suffix = url.slice(actual.origin.length).split("#")[0] ?? "";
    const [pathname, query = ""] = suffix.split("?");
    const segments = (pathname || "/").split("/");
    const expected = pattern.path.split("/");
    return (
      method.toUpperCase() === pattern.method.toUpperCase() &&
      actual.origin === pattern.origin &&
      segments.length === expected.length &&
      expected.every((part, index) =>
        part.startsWith(":") ? segments[index] !== "" : part === segments[index]
      ) &&
      Object.entries(pattern.query).every(([key, value]) =>
        query.split("&").some((pair) => {
          const [name, content = ""] = pair.split("=");
          return (
            decodeURIComponent(name?.replaceAll("+", " ") ?? "") === key &&
            decodeURIComponent(content.replaceAll("+", " ")) === value
          );
        })
      )
    );
  } catch {
    return false;
  }
};
export const browserCheckCoverage = (run: {
  readonly browserChecks?: readonly BrowserCheckReference[];
  readonly browserCheckResults?: readonly BrowserCheckResult[];
}) => {
  const requirements = run.browserChecks ?? [];
  const fulfilled = requirements.filter(({ flowSkillName, check }) => {
    const result = run.browserCheckResults?.findLast(
      (candidate) =>
        candidate.flowSkillName === flowSkillName && candidate.id === check.id
    );
    return result?.status === "passed";
  }).length;
  return {
    complete: fulfilled === requirements.length,
    fulfilled,
    total: requirements.length,
  };
};
