import { isDeepStrictEqual } from "node:util";

import { BrowserCheck } from "@contingency/protocol";
import type {
  BrowserCheckReference,
  FlowSkillFile,
  TeachingBrowserAttachment,
  TeachingInstruction,
} from "@contingency/protocol";
import { Effect, Predicate, Result, Schema } from "effect";

export const BROWSER_CHECKS_FILE = "references/browser-checks.json";
const document = Schema.Struct({
  requirements: Schema.Array(BrowserCheck).check(Schema.isMaxLength(50)),
  schemaVersion: Schema.Literal(1),
});
const invalid = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});
const variableReference = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/u;
const inputReference = /\{\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}\}/gu;

export const resolveBrowserCheckInputs = (
  reference: BrowserCheckReference,
  lookup: (name: string) => string | undefined
) =>
  Effect.gen(function* resolveCheckInputs() {
    const substitutions = new Map<string, string>();
    for (const match of JSON.stringify(reference.check).matchAll(
      inputReference
    )) {
      const name = match.groups?.name;
      if (name === undefined) {
        continue;
      }
      const value = lookup(name);
      if (value === undefined) {
        return yield* Effect.fail(
          invalid(
            `Supply the declared Variable ${name} before evaluating this Browser Check.`
          )
        );
      }
      substitutions.set(name, value);
    }
    const substitute = (value: string) =>
      value.replaceAll(
        inputReference,
        (original, name: string) => substitutions.get(name) ?? original
      );
    const { check } = reference;
    const expectation = {
      ...check.expectation,
      predicates: check.expectation.predicates.map((predicate) =>
        Predicate.isString(predicate.expected)
          ? { ...predicate, expected: substitute(predicate.expected) }
          : predicate
      ),
    };
    const resolved: BrowserCheck =
      check.kind === "response"
        ? {
            ...check,
            expectation,
            request: {
              ...check.request,
              origin: substitute(check.request.origin),
              path: substitute(check.request.path),
              query: Object.fromEntries(
                Object.entries(check.request.query).map(([key, value]) => [
                  key,
                  substitute(value),
                ])
              ),
            },
          }
        : {
            ...check,
            expectation,
            name: substitute(check.name),
            origin: substitute(check.origin),
          };
    return { ...reference, check: resolved };
  });
const validatePredicates = (check: BrowserCheck): string | undefined => {
  for (const predicate of check.expectation.predicates) {
    const privateField =
      check.kind === "cookie" ||
      /token|password|secret|authorization|session.?id|api.?key/iu.test(
        [...check.expectation.itemPath, ...predicate.path].join(".")
      );
    if (
      privateField &&
      predicate.operator !== "exists" &&
      (!Predicate.isString(predicate.expected) ||
        !variableReference.test(predicate.expected))
    ) {
      return "Use a declared Variable reference for a private expectation, or check its existence. Private literals cannot enter the learned requirement.";
    }
    if (predicate.operator !== "exists" && predicate.expected === undefined) {
      return "A value predicate requires an explicit typed expected value.";
    }
    if (predicate.path.includes("*")) {
      return "Put array wildcards in itemPath so grouped predicates match the same item.";
    }
    if (
      predicate.operator === "contains" &&
      !Predicate.isString(predicate.expected)
    ) {
      return "String containment requires a string expectation.";
    }
    if (
      ["gt", "gte", "lt", "lte"].includes(predicate.operator) &&
      !Predicate.isNumber(predicate.expected)
    ) {
      return "Numeric comparisons require a number expectation.";
    }
  }
};
const validateStorageFormat = (check: BrowserCheck): string | undefined => {
  if (check.kind === "response") {
    return;
  }
  if (check.kind === "cookie" && check.format !== undefined) {
    return "Cookies are checked as raw strings. Remove the storage format.";
  }
  if (
    check.format !== "json" &&
    (check.expectation.itemPath.length > 0 ||
      check.expectation.predicates.some(
        (predicate) => predicate.path.length > 0
      ))
  ) {
    return check.kind === "cookie"
      ? "Cookie values are raw strings. Clear the array item path and field paths."
      : "Raw storage values are strings. Clear the array item path and field paths, or choose JSON storage format to check fields.";
  }
  if (
    check.format !== "json" &&
    check.expectation.predicates.some(
      (predicate) =>
        predicate.operator !== "exists" &&
        !Predicate.isString(predicate.expected)
    )
  ) {
    return "Raw values are strings. Compare them with a string expectation, or choose JSON storage format for typed values.";
  }
};
export const validateBrowserCheck = (
  check: BrowserCheck
): string | undefined => {
  try {
    const origin = new URL(
      check.kind === "response" ? check.request.origin : check.origin
    );
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.origin !== origin.href.replace(/\/$/u, "")
    ) {
      return "Browser Checks require an HTTP(S) origin without a path or credentials.";
    }
    if (
      check.kind === "response" &&
      (!check.request.path.startsWith("/") ||
        check.request.path.includes("?") ||
        !/^[A-Z]+$/u.test(check.request.method))
    ) {
      return "Review the request method, path segments, and separate query constraints.";
    }
    return validateStorageFormat(check) ?? validatePredicates(check);
  } catch {
    return "Browser Checks require a valid HTTP(S) origin.";
  }
};

export const validateTeachingAttachments = (
  instructions: readonly TeachingInstruction[],
  attachments: readonly TeachingBrowserAttachment[] | undefined,
  replaceId: string | undefined,
  scan: TeachingInstruction["scan"],
  privateValues: readonly string[]
) =>
  Effect.gen(function* validateCommentChecks() {
    const replacing = instructions.find((entry) => entry.id === replaceId);
    if (replaceId !== undefined && replacing === undefined) {
      return yield* Effect.fail(
        invalid("This comment is stale. Reread the recording before editing.")
      );
    }
    if (replacing !== undefined && !isDeepStrictEqual(replacing.scan, scan)) {
      return yield* Effect.fail(
        invalid("Editing a comment must preserve its scan requirement.")
      );
    }
    const existing = instructions.flatMap((entry) =>
      entry.id === replaceId ? [] : (entry.attachments ?? [])
    );
    const all = [...existing, ...(attachments ?? [])];
    if (
      all.filter((attachment) => attachment.requirement !== undefined).length >
      50
    ) {
      return yield* Effect.fail(
        invalid("A recording supports up to 50 required Browser Checks.")
      );
    }
    const identities = all.map((attachment) => attachment.id);
    if (new Set(identities).size !== identities.length) {
      return yield* Effect.fail(
        invalid("Browser attachment IDs must be unique in the recording.")
      );
    }
    for (const attachment of attachments ?? []) {
      const check = attachment.requirement ?? attachment.candidate;
      const problem = validateBrowserCheck(check);
      if (problem !== undefined) {
        return yield* Effect.fail(invalid(problem));
      }
      if (attachment.id !== check.id) {
        return yield* Effect.fail(
          invalid("Preserve the attachment ID as its Browser Check ID.")
        );
      }
      const serialized = JSON.stringify(attachment);
      if (
        privateValues.some(
          (value) =>
            // oxlint-disable-next-line react-doctor/js-set-map-lookups -- This is substring detection in serialized text, not membership in an array.
            value.length > 0 && serialized.includes(value)
        )
      ) {
        return yield* Effect.fail(
          invalid(
            "Use a Variable reference instead of a private literal in a Browser attachment."
          )
        );
      }
    }
    return replacing;
  });
export const parseBrowserChecks = (files: readonly FlowSkillFile[]) => {
  const file = files.find(
    (candidate) => candidate.path === BROWSER_CHECKS_FILE
  );
  if (file === undefined) {
    return Result.succeed<readonly BrowserCheck[]>([]);
  }
  try {
    const parsed = Schema.decodeUnknownSync(document)(JSON.parse(file.content));
    const skill = files.find((candidate) => candidate.path === "SKILL.md");
    const ids = new Set<string>();
    for (const requirement of parsed.requirements) {
      const problem = validateBrowserCheck(requirement);
      if (problem !== undefined) {
        return Result.fail(invalid(problem));
      }
      if (ids.has(requirement.id)) {
        return Result.fail(invalid("Browser Check IDs must be unique."));
      }
      ids.add(requirement.id);
      if (
        !skill?.content.includes(BROWSER_CHECKS_FILE) ||
        !skill.content.includes(requirement.id)
      ) {
        return Result.fail(
          invalid(
            `Link ${BROWSER_CHECKS_FILE} and name check ${requirement.id} in SKILL.md.`
          )
        );
      }
    }
    return Result.succeed(parsed.requirements);
  } catch {
    return Result.fail(
      invalid(
        `Invalid ${BROWSER_CHECKS_FILE}. Review its schema and typed expectations.`
      )
    );
  }
};
export const requestedBrowserChecks = (
  skills: readonly {
    readonly name: string;
    readonly files: readonly FlowSkillFile[];
  }[]
) =>
  Effect.gen(function* loadBrowserChecks() {
    const references: BrowserCheckReference[] = [];
    for (const skill of skills) {
      const parsed = parseBrowserChecks(skill.files);
      if (Result.isFailure(parsed)) {
        return yield* Effect.fail(parsed.failure);
      }
      references.push(
        ...parsed.success.map((check) => ({ check, flowSkillName: skill.name }))
      );
    }
    if (references.length > 100) {
      return yield* Effect.fail(
        invalid("A Run supports up to 100 Browser Checks.")
      );
    }
    return references;
  });
export const validateTaughtBrowserChecks = (
  files: readonly FlowSkillFile[],
  events: readonly {
    readonly attachments?: readonly TeachingBrowserAttachment[] | undefined;
  }[]
) =>
  Effect.gen(function* preserveTaughtChecks() {
    const parsed = parseBrowserChecks(files);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(parsed.failure);
    }
    const taught = events.flatMap(
      (event) =>
        event.attachments?.flatMap((attachment) =>
          attachment.requirement === undefined ? [] : [attachment.requirement]
        ) ?? []
    );
    if (
      taught.length !== parsed.success.length ||
      taught.some(
        (check) =>
          !parsed.success.some((saved) =>
            isDeepStrictEqual(
              saved,
              Schema.decodeUnknownSync(BrowserCheck)(check)
            )
          )
      )
    ) {
      return yield* Effect.fail(
        invalid(
          "Preserve every reviewed Browser Check exactly in references/browser-checks.json. Context attachments are not requirements."
        )
      );
    }
  });
