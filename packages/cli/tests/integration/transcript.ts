import path from "node:path";

import { OperationId } from "@contingency/protocol";
import { Context, Effect, FileSystem, Predicate, Schema } from "effect";

/**
 * A Scripted Agent transcript: every program a journey sent to
 * `agent_code_execute`, what each one ended with, and the user's actions
 * between them, so the journey can be replayed against a fresh process. The
 * format is documented in `docs/agents/testing.md#transcripts`.
 */

/** Set to `1` to rewrite the committed transcripts; nothing else writes them. */
export const RECORD_TRANSCRIPTS = process.env["RECORD_TRANSCRIPTS"] === "1";

export const TRANSCRIPT_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "transcripts"
);

const Token = Schema.String.check(Schema.isPattern(/^\{\{[A-Za-z0-9]+\}\}$/u));

/** Where a value a program sends came from, so a replay can send its own. */
export const TranscriptBinding = Schema.Struct({
  from: Schema.Union([
    /** A field of an earlier program's value. */
    Schema.TaggedStruct("step", {
      path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
      step: Schema.Int,
    }),
    /** A value the replaying test supplies, such as the fixture origin. */
    Schema.TaggedStruct("environment", { name: Schema.String }),
  ]),
  token: Token,
});
export type TranscriptBinding = typeof TranscriptBinding.Type;

/** What a program ended with, as a replay must reproduce it. */
export const ProgramOutcome = Schema.Struct({
  /** The code of the operation failure the program ended with, if any. */
  failureCode: Schema.NullOr(Schema.String),
  /** The receipts the tool returned: only those that did not succeed. */
  receipts: Schema.Array(
    Schema.Struct({ operation: Schema.String, outcome: Schema.String })
  ),
  status: Schema.String,
});
export type ProgramOutcome = typeof ProgramOutcome.Type;

/** What the user does in the Workspace between the agent's programs. */
export const UserAction = Schema.Union([
  Schema.TaggedStruct("click", {
    sessionId: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
  }),
  Schema.TaggedStruct("type", {
    sessionId: Schema.String,
    text: Schema.String,
  }),
  Schema.TaggedStruct("start-recording", {
    operationId: OperationId,
    sessionId: Schema.String,
  }),
  Schema.TaggedStruct("stop-recording", {
    operationId: OperationId,
    sessionId: Schema.String,
  }),
  Schema.TaggedStruct("takeover", {
    reason: Schema.String,
    sessionId: Schema.String,
  }),
  Schema.TaggedStruct("return-control", { sessionId: Schema.String }),
  Schema.TaggedStruct("supply-variable", {
    name: Schema.String,
    sessionId: Schema.String,
    value: Schema.String,
  }),
]);
export type UserAction = typeof UserAction.Type;

export const TranscriptStep = Schema.Union([
  /** A new MCP process over the same Catalog Root. */
  Schema.TaggedStruct("process", {}),
  Schema.TaggedStruct("program", {
    code: Schema.String,
    outcome: ProgramOutcome,
  }),
  Schema.TaggedStruct("user", { action: UserAction }),
]);
export type TranscriptStep = typeof TranscriptStep.Type;

export const Transcript = Schema.Struct({
  bindings: Schema.Array(TranscriptBinding),
  journey: Schema.String,
  schemaVersion: Schema.Literal(1),
  steps: Schema.Array(TranscriptStep),
});
export type Transcript = typeof Transcript.Type;

/** How a program ended, as `agent_code_execute` returns it. */
export interface ProgramEnding {
  readonly diagnostic?:
    | { readonly kind: string; readonly message: string }
    | undefined;
  readonly receipts?:
    | readonly { readonly operation: string; readonly outcome: string }[]
    | undefined;
  readonly status: string;
}

/** How a program ended, with what it returned or why it stopped for the user. */
export interface ProgramAnswer extends ProgramEnding {
  readonly intervention?: Schema.JsonObject | undefined;
  readonly value?: Schema.Json | undefined;
}

/** A JSON value that is an object, not an array. */
export const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/** The parts of an answer a later program may send values from. */
export const answeredValues = ({
  intervention,
  value,
}: ProgramAnswer): Schema.JsonObject => ({
  intervention: intervention ?? null,
  value: value ?? null,
});

/**
 * A failed operation's code and Failure Reference, read from the message the
 * agent receives: `<message> (<code>)`, then `(failureReference <ref>)` when
 * the failure has one.
 */
export const failureCodeOf = (message: string) =>
  /\((?<code>[a-z][a-z0-9_]*)\)(?: \(failureReference (?<reference>[0-9A-Z]{6})\))?$/u.exec(
    message
  )?.groups;

export const outcomeOf = (ending: ProgramEnding): ProgramOutcome => ({
  failureCode:
    ending.status === "program_failed" &&
    ending.diagnostic?.kind === "ToolFailure"
      ? (failureCodeOf(ending.diagnostic.message)?.["code"] ?? null)
      : null,
  receipts: (ending.receipts ?? []).map(({ operation, outcome }) => ({
    operation,
    outcome,
  })),
  status: ending.status,
});

type Segment = string | number;

/**
 * Fields whose value a process mints and a later program sends back. An
 * operation id is the agent's own, so it is recorded as written.
 */
const isBindable = (key: string) =>
  !/(?:^o|O)perationId$/u.test(key) &&
  (key === "id" || /(?:Id|Cursor)$/u.test(key));

/**
 * Keys whose value says what a step is, not what it carries: a tag, a kind,
 * a name, or a format. Redaction never rewrites them.
 */
const STRUCTURAL_KEYS = new Set([
  "_tag",
  "button",
  "eventType",
  "format",
  "name",
  "operation",
  "operationId",
  "role",
  "type",
  "view",
]);

/** Every bindable value in a program's value, first occurrence first. */
const bindableValues = (value: Schema.Json) => {
  const found = new Map<string, readonly Segment[]>();
  const visit = (node: Schema.Json, at: readonly Segment[]) => {
    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) {
        visit(child, [...at, index]);
      }
      return;
    }
    if (!isJsonObject(node)) {
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (isBindable(key) && Predicate.isString(child) && !found.has(child)) {
        found.set(child, [...at, key]);
      }
      visit(child, [...at, key]);
    }
  };
  visit(value, []);
  return found;
};

/** A string as it is written inside a JSON string literal. */
const escaped = (value: string) => JSON.stringify(value).slice(1, -1);

/** Writes each token's value into a program or user action template. */
export const substitute = (
  template: string,
  values: ReadonlyMap<string, string>
) => {
  let resolved = template;
  for (const [token, value] of values) {
    resolved = resolved.replaceAll(token, () => escaped(value));
  }
  return resolved;
};

/**
 * Records one journey as it runs. A value a program sends that came from an
 * earlier program, or from the environment, is written as a token, so the
 * transcript replays against another process.
 */
export const makeRecorder = () => {
  const steps: TranscriptStep[] = [];
  const bindings: TranscriptBinding[] = [];
  const sources: ReadonlyMap<string, readonly Segment[]>[] = [];
  const environment = new Map<string, string>();
  const live = new Map<string, string>();
  let supplied = 0;

  const tokenFor = (value: string, key: string | undefined) => {
    if (key !== undefined && STRUCTURAL_KEYS.has(key)) {
      return value;
    }
    // The earliest answer that holds the value is the one that minted it.
    for (const [step, values] of sources.entries()) {
      const at = values.get(value);
      if (at === undefined) {
        continue;
      }
      const existing = bindings.find(
        ({ from }) =>
          from._tag === "step" &&
          from.step === step &&
          from.path.join("/") === at.join("/")
      );
      if (existing !== undefined) {
        return existing.token;
      }
      const token = `{{b${bindings.filter(({ from: source }) => source._tag === "step").length + 1}}}`;
      bindings.push({ from: { _tag: "step", path: at, step }, token });
      live.set(token, value);
      return token;
    }
    // An id or cursor is bound whole or kept; only payload text is redacted.
    if (key !== undefined && isBindable(key)) {
      return value;
    }
    let written = value;
    for (const [name, environmentValue] of environment) {
      if (!written.includes(environmentValue)) {
        continue;
      }
      const token = `{{${name}}}`;
      if (!bindings.some((binding) => binding.token === token)) {
        bindings.push({ from: { _tag: "environment", name }, token });
        live.set(token, environmentValue);
      }
      written = written.replaceAll(environmentValue, token);
    }
    return written;
  };

  /** `key` is the field the value sits in; an array's items share it. */
  const tokenize = (value: Schema.Json, key?: string): Schema.Json => {
    if (Predicate.isString(value)) {
      return tokenFor(value, key);
    }
    if (Array.isArray(value)) {
      return value.map((item) => tokenize(item, key));
    }
    if (isJsonObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([field, child]) => [
          field,
          tokenize(child, field),
        ])
      );
    }
    return value;
  };

  const tokenizeObject = (input: Schema.JsonObject): Schema.JsonObject =>
    Object.fromEntries(
      Object.entries(input).map(([field, child]) => [
        field,
        tokenize(child, field),
      ])
    );

  /**
   * A value the user supplies is the user's, never the agent's, so each one
   * is its own environment token, `{{supplied<n>}}`, the replay fills in.
   */
  const suppliedToken = (value: string) => {
    supplied += 1;
    const name = `supplied${supplied}`;
    const token = `{{${name}}}`;
    bindings.push({ from: { _tag: "environment", name }, token });
    live.set(token, value);
    // A later step that repeats the value sends the token too.
    environment.set(name, value);
    return token;
  };

  return {
    /** Names a value the replaying test supplies, such as an origin. */
    environment: (name: string, value: string) => {
      environment.set(name, value);
    },
    /** The template as this run sends it, with every token's value written in. */
    live: (template: string) => substitute(template, live),
    process: () => {
      steps.push({ _tag: "process" });
      sources.push(new Map());
    },
    program: (code: string, answer: ProgramAnswer) => {
      steps.push({ _tag: "program", code, outcome: outcomeOf(answer) });
      sources.push(bindableValues(answeredValues(answer)));
    },
    /** An input with each bound value written as its token. */
    tokenize: tokenizeObject,
    transcript: (journey: string): Transcript => ({
      bindings: [...bindings],
      journey,
      schemaVersion: 1,
      steps: [...steps],
    }),
    user: (action: UserAction) => {
      const tokenized = Schema.decodeUnknownSync(UserAction)(
        tokenizeObject(action)
      );
      steps.push({
        _tag: "user",
        action:
          action._tag === "supply-variable" &&
          tokenized._tag === "supply-variable"
            ? { ...tokenized, value: suppliedToken(action.value) }
            : tokenized,
      });
      sources.push(new Map());
    },
  };
};
export type Recorder = ReturnType<typeof makeRecorder>;

/** How the Scripted Agent reaches Contingency. */
export type Adapter = "in-process" | "http";

/**
 * One journey's script: the adapter it runs on, the operation ids it mints,
 * and its transcript. A transcript holds programs that were actually sent, so
 * only the HTTP adapter records.
 */
export class Script extends Context.Service<
  Script,
  {
    readonly adapter: Adapter;
    readonly mint: () => OperationId;
    readonly recorder: Recorder;
  }
>()("@contingency/tests/Script") {}

export const makeScript = (adapter: Adapter) => {
  let minted = 0;
  return Script.of({
    adapter,
    mint: () => {
      minted += 1;
      return OperationId.make(`scripted-${minted}`);
    },
    recorder: makeRecorder(),
  });
};

/** Names a value the replaying test supplies, such as the fixture origin. */
export const bindEnvironment = (name: string, value: string) =>
  Effect.gen(function* bindEnvironmentValue() {
    const script = yield* Script;
    script.recorder.environment(name, value);
  });

/** An operation id for a call that must reuse it, as a replayed start does. */
export const mintOperationId = Effect.gen(function* mintOperation() {
  const script = yield* Script;
  return script.mint();
});

const transcriptPath = (journey: string) =>
  path.join(TRANSCRIPT_DIRECTORY, `${journey}.json`);

export const writeTranscript = (transcript: Transcript) =>
  Effect.gen(function* writeTranscriptFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(Transcript)(transcript);
    yield* fileSystem.makeDirectory(TRANSCRIPT_DIRECTORY, { recursive: true });
    yield* fileSystem.writeFileString(
      transcriptPath(transcript.journey),
      `${JSON.stringify(encoded, null, 2)}\n`
    );
  });

export const readTranscript = (journey: string) =>
  Effect.gen(function* readTranscriptFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(transcriptPath(journey));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Transcript))(
      text
    );
  });
