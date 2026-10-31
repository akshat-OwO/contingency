import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BrowserDevtoolsCommand } from "@contingency/protocol";
import type {
  BrowserModification,
  FlowSkillFile,
  TeachingEvent,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";

import { readFlowSkillFrontmatter } from "./flow-skill-package.ts";

export const BROWSER_STATE_FILE = "references/browser-state.json";
const VARIABLE_SLOT = /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/u;
const requiredModification = Schema.Struct({
  command: BrowserDevtoolsCommand,
  id: Schema.String,
  when: Schema.String,
});
const savedState = Schema.Struct({
  modifications: Schema.Array(requiredModification),
  schemaVersion: Schema.Literal(1),
});
export type RequiredBrowserModification = typeof requiredModification.Type;

export const parameterizeBrowserCommand = (
  command: BrowserDevtoolsCommand,
  variable: (value: string, hint: string) => string
): BrowserDevtoolsCommand => {
  if (command.action === "cookie_set") {
    return {
      ...command,
      cookie: {
        ...command.cookie,
        value: variable(command.cookie.value, `COOKIE_${command.cookie.name}`),
      },
    };
  }
  if (command.action === "headers_set") {
    return {
      ...command,
      headers: Object.fromEntries(
        Object.entries(command.headers).map(([name, value]) => [
          name,
          variable(value, `HEADER_${name}`),
        ])
      ),
    };
  }
  return command;
};

export const browserVariableReference =
  (names: Set<string>, replacements: Map<string, string>) =>
  (value: string, hint: string): string => {
    const slot = /^\{\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}\}$/u.exec(value)
      ?.groups?.name;
    let name = slot ?? replacements.get(value);
    if (name === undefined) {
      const base = hint.toUpperCase().replaceAll(/[^A-Z0-9_]+/gu, "_");
      name = base;
      let suffix = 1;
      while (names.has(name)) {
        suffix += 1;
        name = `${base}_${suffix}`;
      }
      replacements.set(value, name);
    }
    names.add(name);
    return `{{${name}}}`;
  };

export const browserValueDigest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const literalValidationError = (
  files: readonly FlowSkillFile[],
  replacements: ReadonlyMap<string, string>,
  events: readonly TeachingEvent[]
): string | undefined => {
  const digests = events.flatMap((event) =>
    event._tag === "browser-modification" ? (event.valueDigests ?? []) : []
  );
  for (const file of files) {
    if (file.path === BROWSER_STATE_FILE) {
      continue;
    }
    const reject = (name: string) =>
      `Replace the recorded value in ${file.path} with Variable {{${name}}} before saving.`;
    for (const [value, name] of replacements) {
      // A reference is the safe form; only recorded literals are refused.
      if (
        value.length >= 8 &&
        !VARIABLE_SLOT.test(value) &&
        file.content.includes(value)
      ) {
        return reject(name);
      }
    }
    for (const { length, digest, name } of digests) {
      if (length < 8) {
        continue;
      }
      for (
        let offset = 0;
        offset + length <= file.content.length;
        offset += 1
      ) {
        if (
          browserValueDigest(file.content.slice(offset, offset + length)) ===
          digest
        ) {
          return reject(name);
        }
      }
    }
  }
  return undefined;
};

/** State is stamped from evidence; an author cannot silently omit a mock. */
export const stampBrowserState = (
  files: readonly FlowSkillFile[],
  events: readonly TeachingEvent[]
) =>
  Effect.gen(function* stampRequiredState() {
    const modifications: RequiredBrowserModification[] = [];
    const delegation: string[] = [];
    const names = new Set(
      files.flatMap((file) =>
        file.path === "SKILL.md"
          ? (readFlowSkillFrontmatter(file.content)?.inputs ?? []).map(
              (input) => input.name
            )
          : []
      )
    );
    const replacements = new Map<string, string>();
    for (const event of events) {
      const value = event._tag === "action" ? event.target?.value : undefined;
      if (
        event._tag === "action" &&
        event.variableName !== undefined &&
        value !== undefined &&
        value !== null
      ) {
        replacements.set(value, event.variableName);
        names.add(event.variableName);
      }
    }
    const requiredNames = new Set<string>();
    const assign = browserVariableReference(names, replacements);
    const reference = (value: string, hint: string): string => {
      const slot = assign(value, hint);
      requiredNames.add(slot.slice(2, -2));
      return slot;
    };
    let when = "At Start, before the first journey action";
    for (const event of events) {
      if (event._tag === "action") {
        when = `After ${event.description}, at ${event.after.url}`;
      } else if (event._tag === "browser-modification") {
        const command = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(BrowserDevtoolsCommand)
        )(event.command);
        modifications.push({
          command: parameterizeBrowserCommand(command, (value, hint) => {
            const existing = event.variableNames?.[hint];
            if (existing !== undefined && !VARIABLE_SLOT.test(value)) {
              replacements.set(value, existing);
            }
            return reference(value, hint);
          }),
          id: event.id,
          when,
        });
      } else if (event._tag === "pursuit") {
        const { pursuit } = event;
        delegation.push(
          `- Delegated: ${pursuit.goal}. Done when: ${pursuit.doneWhen}. Recorded result: ${pursuit.ending}. ${pursuit.reason}`
        );
      }
    }
    if (modifications.length === 0 && delegation.length === 0) {
      return files;
    }
    const instructions = [
      "\n## Recorded Run requirements\n",
      ...(modifications.length === 0
        ? []
        : [
            "Apply the [required browser state](references/browser-state.json) in order at its recorded journey outcomes. Active setup state applies at Start. Keep each modification until its recorded removal or Run end. Use fresh operation IDs; resolve removal IDs from the Dry Run's modification list. A failed application prevents a passing Dry Run.\n",
          ]),
      ...Array.from(
        requiredNames,
        (name) =>
          `- Required Variable: {{${name}}}. Supply it fresh through the Dry Run Variable request.`
      ),
      ...delegation,
    ].join("\n");
    const validationError = literalValidationError(files, replacements, events);
    if (validationError !== undefined) {
      return yield* Effect.fail({ message: validationError });
    }
    const declared = new Set(
      files.flatMap((file) =>
        file.path === "SKILL.md"
          ? (readFlowSkillFrontmatter(file.content)?.inputs ?? []).map(
              (input) => input.name
            )
          : []
      )
    );
    const declarations = [...requiredNames]
      .flatMap((name) => (declared.has(name) ? [] : [`  - ${name}`]))
      .join("\n");
    return [
      ...files.flatMap((original) => {
        const file = original;
        return file.path === BROWSER_STATE_FILE
          ? []
          : [
              file.path === "SKILL.md"
                ? {
                    ...file,
                    content:
                      (declarations.length === 0
                        ? file.content
                        : file.content.replace(
                            /^inputs:[^\n]*$/mu,
                            (match) => `${match}\n${declarations}`
                          )) + instructions,
                  }
                : file,
            ];
      }),
      ...(modifications.length === 0
        ? []
        : [
            {
              content: `${JSON.stringify({ modifications, schemaVersion: 1 }, null, 2)}\n`,
              path: BROWSER_STATE_FILE,
            },
          ]),
    ];
  });

export const readBrowserState = (files: readonly FlowSkillFile[]) => {
  const file = files.find((entry) => entry.path === BROWSER_STATE_FILE);
  return file === undefined
    ? Effect.succeed<readonly RequiredBrowserModification[]>([])
    : Schema.decodeUnknownEffect(Schema.fromJsonString(savedState))(
        file.content
      ).pipe(Effect.map((value) => value.modifications));
};

/** Operation IDs are attempts; saved IDs identify required state across contexts. */
export const matchesRequiredModification = (
  required: RequiredBrowserModification,
  command: BrowserDevtoolsCommand,
  applied: readonly BrowserModification[],
  supplied: (name: string) => string | undefined = () => {
    /* empty */
  }
): boolean => {
  let missing = false;
  const expected = {
    ...parameterizeBrowserCommand(required.command, (value) => {
      const name = /^\{\{(?<name>[^{}]+)\}\}$/u.exec(value)?.groups?.name;
      if (name === undefined) {
        return value;
      }
      const resolved = supplied(name);
      if (resolved === undefined) {
        missing = true;
      }
      return resolved ?? value;
    }),
  };
  const actual = { ...command };
  if ("operationId" in expected) {
    expected.operationId = "saved";
  }
  if ("operationId" in actual) {
    actual.operationId = "saved";
  }
  if (
    expected.action === "modification_remove" &&
    actual.action === "modification_remove"
  ) {
    const source = applied.find((entry) => entry.id === actual.id)?.savedId;
    actual.id = source ?? actual.id;
  }
  // Upload targets are rediscovered in the fresh Snapshot, never replayed by ref.
  if (expected.action === "upload" && actual.action === "upload") {
    expected.ref = "target";
    actual.ref = "target";
  }
  return !missing && isDeepStrictEqual(expected, actual);
};
