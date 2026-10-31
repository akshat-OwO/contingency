import { isDeepStrictEqual } from "node:util";

import { BrowserDevtoolsCommand } from "@contingency/protocol";
import type {
  BrowserModification,
  FlowSkillFile,
  TeachingEvent,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";

export const BROWSER_STATE_FILE = "references/browser-state.json";
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

/** State is stamped from evidence; an author cannot silently omit a mock. */
export const stampBrowserState = (
  files: readonly FlowSkillFile[],
  events: readonly TeachingEvent[]
) =>
  Effect.gen(function* stampRequiredState() {
    const modifications: RequiredBrowserModification[] = [];
    const delegation: string[] = [];
    let when = "At Start, before the first journey action";
    for (const event of events) {
      if (event._tag === "action") {
        when = `After ${event.description}, at ${event.after.url}`;
      } else if (event._tag === "browser-modification") {
        const command = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(BrowserDevtoolsCommand)
        )(event.command);
        modifications.push({ command, id: event.id, when });
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
      ...delegation,
    ].join("\n");
    return [
      ...files
        .filter((file) => file.path !== BROWSER_STATE_FILE)
        .map((file) =>
          file.path === "SKILL.md"
            ? { ...file, content: file.content + instructions }
            : file
        ),
      ...(modifications.length === 0
        ? []
        : [
            {
              path: BROWSER_STATE_FILE,
              content:
                JSON.stringify({ modifications, schemaVersion: 1 }, null, 2) +
                "\n",
            },
          ]),
    ];
  });

export const readBrowserState = (files: readonly FlowSkillFile[]) => {
  const file = files.find((entry) => entry.path === BROWSER_STATE_FILE);
  return file === undefined
    ? Effect.succeed([] as readonly RequiredBrowserModification[])
    : Schema.decodeUnknownEffect(Schema.fromJsonString(savedState))(
        file.content
      ).pipe(Effect.map((value) => value.modifications));
};

/** Operation IDs are attempts; saved IDs identify required state across contexts. */
export const matchesRequiredModification = (
  required: RequiredBrowserModification,
  command: BrowserDevtoolsCommand,
  applied: readonly BrowserModification[]
): boolean => {
  const expected = { ...required.command };
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
  return isDeepStrictEqual(expected, actual);
};
