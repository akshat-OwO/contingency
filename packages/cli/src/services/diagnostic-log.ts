// oxlint-disable anti-slop/no-unknown-parameters -- This module is the boundary that renders log values; a record's message and annotations are unknown by definition, and the allowlist below is their parser.
import path from "node:path";

import {
  Cause,
  Clock,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Predicate,
  References,
  Schema,
} from "effect";
import type { Fiber, LogLevel } from "effect";
import { constVoid } from "effect/Function";

/**
 * The Diagnostic Log: one process's local record of what it did and why its
 * failures happened ([ADR 0089](../../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 *
 * It is safe to share as-is, so safety is an allowlist the renderer enforces
 * rather than something a caller or the user must remember. A message is a
 * fixed string (the `contingency/fixed-log-message` lint rule), each value
 * that changes is an annotation whose key names a safe kind, and anything the
 * allowlist does not recognise renders as `<redacted>`. A cause is rendered
 * by its shape (tags, codes, and stack frames), never by its message. The
 * terminal uses the same renderer, so pasted `--debug` output is safe too.
 */

export const REDACTED = "<redacted>";

/** One rendered field: its key and its already-safe value. */
export type SafeField = readonly [key: string, value: string];

/** A log record after the allowlist, ready for any sink. */
export interface SafeRecord {
  readonly level: LogLevel.Severity;
  readonly date: Date;
  /** The innermost tracing span the record was logged in. */
  readonly span: string | undefined;
  readonly message: string;
  readonly fields: readonly SafeField[];
  /** The cause, one line per failure, tag, code, or stack frame. */
  readonly cause: readonly string[];
  /** Milliseconds since the innermost log span started. */
  readonly durationMs: number | undefined;
}

const CODE = /^[\w.:/@+#=-]{1,96}$/u;
const HOST = /^[\w.-]{1,253}(?::\d{1,5})?$/u;
// oxlint-disable-next-line no-control-regex -- control characters are what this strips.
const CONTROL = /[\u0000-\u001F\u007F]/gu;
const MAX_MESSAGE = 240;
const MAX_NAME = 120;
const MAX_FRAMES = 8;
const MAX_CAUSE_DEPTH = 4;

type Render = (value: unknown, home?: string) => string | undefined;

const scalar = (value: unknown): string | undefined =>
  Predicate.isNumber(value) ||
  Predicate.isBoolean(value) ||
  Predicate.isBigInt(value)
    ? String(value)
    : undefined;

/** An identifier, enum value, or code: a short token with no spaces. */
const code: Render = (value) =>
  Predicate.isString(value) && CODE.test(value) ? value : scalar(value);

/** A number of something: a count, duration, size, port, or exit code. */
const count: Render = (value) => scalar(value);

/** A host, never a path: a URL's path or query may carry user data. */
const host: Render = (value) => {
  if (!Predicate.isString(value)) {
    return;
  }
  if (HOST.test(value)) {
    return value;
  }
  try {
    const parsed = new URL(value);
    return parsed.host === ""
      ? parsed.protocol.replace(/:$/u, "")
      : parsed.host;
  } catch {
    // Not a URL, so nothing in it is known to be a host.
  }
};

/** Replaces the home directory with `~`, so no account name is written. */
export const tildePath = (value: string, home: string): string => {
  if (home === "" || home === "/") {
    return value;
  }
  return value === home || value.startsWith(`${home}${path.sep}`)
    ? `~${value.slice(home.length)}`
    : value;
};

/** A local file path, or a path on Contingency's own server, without query. */
const filePath: Render = (value, home = "") =>
  Predicate.isString(value)
    ? tildePath(value.split(/[?#]/u, 1)[0] ?? "", home).replace(CONTROL, "")
    : undefined;

/** An authored name, such as a Flow or Group, which may be committed. */
const name: Render = (value) =>
  Predicate.isString(value)
    ? value.replace(CONTROL, "").slice(0, MAX_NAME)
    : undefined;

const ownTag = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)
    ? code(error._tag)
    : undefined;

/** An error's tag, and its reason's, as in `HttpServerError.RouteNotFound`. */
const errorTag = (error: unknown): string => {
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) {
    const tag = code(error._tag) ?? "Error";
    const reason = Predicate.hasProperty(error, "reason")
      ? ownTag(error.reason)
      : undefined;
    return reason === undefined ? tag : `${tag}.${reason}`;
  }
  if (error instanceof Error) {
    return code(error.name) ?? "Error";
  }
  return "Error";
};

const errorCode = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "code") ? code(error.code) : undefined;

/** Timed steps, such as a capture's: each name, outcome, and duration. */
const steps: Render = (value) => {
  if (!Array.isArray(value)) {
    return;
  }
  const rendered = value.map((entry: unknown) => {
    if (!Predicate.isObject(entry)) {
      return REDACTED;
    }
    const durationMs = count(entry.durationMs);
    return [
      code(entry.step),
      code(entry.outcome),
      durationMs === undefined ? undefined : `${durationMs}ms`,
    ]
      .map((part) => part ?? REDACTED)
      .join(":");
  });
  return rendered.join(",");
};

/** Numeric readings, such as a memory sample: each number, by its name. */
const readings: Render = (value) => {
  if (!Predicate.isObject(value)) {
    return;
  }
  return Object.entries(value)
    .map(
      ([key, reading]) =>
        `${code(key) ?? REDACTED}:${count(reading) ?? REDACTED}`
    )
    .join(",");
};

/** An error by its tag and its code, never its message. */
const errorSummary: Render = (value) => {
  if (!Predicate.isObject(value) && !(value instanceof Error)) {
    return;
  }
  const errorCodeValue = errorCode(value);
  return errorCodeValue === undefined
    ? errorTag(value)
    : `${errorTag(value)}(${errorCodeValue})`;
};

/**
 * Every annotation key a record may carry, and how its value renders. A key
 * missing here renders `<redacted>`, so a new kind of value is a reviewed
 * change to this table.
 */
const FIELD_KINDS = new Map<string, Render>([
  ["action", code],
  ["attempt", count],
  ["bytes", count],
  ["bytesFromInterpreter", count],
  ["bytesToInterpreter", count],
  ["code", code],
  ["count", count],
  ["deviceId", code],
  ["directory", filePath],
  ["durationMs", count],
  ["error", errorSummary],
  ["exitCode", count],
  ["failureReference", code],
  ["file", filePath],
  ["flow", name],
  ["group", name],
  ["harness", code],
  ["heapLimitBytes", count],
  ["helperFailure", code],
  ["host", host],
  ["http.method", code],
  ["http.status", count],
  ["kind", code],
  ["label", code],
  ["lastMemory", readings],
  ["level", code],
  ["mode", code],
  ["observationId", code],
  ["operation", code],
  ["operationId", code],
  ["outcome", code],
  ["path", filePath],
  ["peakRssBytes", count],
  ["phase", code],
  ["pid", count],
  ["platform", code],
  ["port", count],
  ["reason", code],
  ["rssCeilingBytes", count],
  ["recordingId", code],
  ["runId", code],
  ["scid", code],
  ["serial", code],
  ["sessionId", code],
  ["signal", code],
  ["startupMs", count],
  ["state", code],
  ["status", code],
  ["step", code],
  ["steps", steps],
  ["tool", code],
  ["udid", code],
  ["url", host],
  ["worker", code],
  // OpenTelemetry attributes Effect's HTTP spans set.
  ["effect.logLevel", code],
  ["http.request.method", code],
  ["http.response.status_code", count],
  // A route template, such as `/api/runs/:id`. Requested paths are never
  // logged: a path segment may carry private data.
  ["http.route", filePath],
  ["server.address", host],
  ["server.port", count],
  ["url.full", host],
  ["url.scheme", code],
]);

/** Renders one annotation through the allowlist. */
export const renderField = (
  key: string,
  value: unknown,
  home: string
): SafeField => [key, FIELD_KINDS.get(key)?.(value, home) ?? REDACTED];

const stackFrames = (error: unknown, home: string): string[] => {
  if (!(error instanceof Error) || error.stack === undefined) {
    return [];
  }
  return error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, MAX_FRAMES)
    .map((line) =>
      home === "" || home === "/" ? line : line.replaceAll(home, "~")
    );
};

const describeFailure = (
  label: string,
  error: unknown,
  home: string,
  depth = 0
): string[] => {
  const summary = errorSummary(error, home) ?? errorTag(error);
  const lines = [`${label} ${summary}`];
  if (depth === 0) {
    lines.push(...stackFrames(error, home).map((frame) => `  ${frame}`));
  }
  const nested = Predicate.hasProperty(error, "cause")
    ? error.cause
    : undefined;
  if (nested !== undefined && nested !== null && depth < MAX_CAUSE_DEPTH) {
    lines.push(
      ...describeFailure("caused by", nested, home, depth + 1).map(
        (line) => `  ${line}`
      )
    );
  }
  return lines;
};

/** A cause by its shape: what failed and where, never what it said. */
export const renderCause = (
  cause: Cause.Cause<unknown>,
  home: string
): string[] =>
  cause.reasons.flatMap((reason) => {
    if (Cause.isFailReason(reason)) {
      return describeFailure("fail", reason.error, home);
    }
    if (Cause.isDieReason(reason)) {
      return describeFailure("die", reason.defect, home);
    }
    return ["interrupted"];
  });

const cleanMessage = (text: string): string => {
  const flat = text.replaceAll(CONTROL, " ").replaceAll(/\s+/gu, " ").trim();
  return flat.length > MAX_MESSAGE
    ? `${flat.slice(0, MAX_MESSAGE - 1)}…`
    : flat;
};

/**
 * A record another process already rendered, such as a worker's, relayed
 * into this process's log. Its fields pass the allowlist again here.
 */
export const RelayedRecord = Schema.Struct({
  cause: Schema.Array(Schema.String),
  fields: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  level: Schema.Literals(["Fatal", "Error", "Warn", "Info", "Debug", "Trace"]),
  message: Schema.String,
  span: Schema.optional(Schema.String),
});
export type RelayedRecord = typeof RelayedRecord.Type;

/** Marks a relayed record so the renderer takes its fields as fields. */
export class Relayed {
  readonly record: RelayedRecord;
  constructor(record: RelayedRecord) {
    this.record = record;
  }
}

const spanName = (fiber: Fiber.Fiber<unknown, unknown>): string | undefined => {
  const { span } = fiber.cache;
  return span?._tag === "Span" ? span.name : undefined;
};

/** `All` and `None` are filters, never a record's level. */
const severity = (level: LogLevel.LogLevel): LogLevel.Severity =>
  level === "All" || level === "None" ? "Info" : level;

/** Applies the allowlist to one record, from any logger's options. */
export const toSafeRecord = (
  options: Logger.Options<unknown>,
  home: string
): SafeRecord => {
  const parts = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const relayed = parts.find((part) => part instanceof Relayed);
  const fields: SafeField[] = [];
  let message = "";
  let cause: string[] = renderCause(options.cause, home);
  let span = spanName(options.fiber);
  if (relayed instanceof Relayed) {
    message = cleanMessage(relayed.record.message);
    span = relayed.record.span ?? span;
    for (const [key, value] of relayed.record.fields) {
      fields.push(renderField(key, value, home));
    }
    cause = [
      ...relayed.record.cause.map((line) => cleanMessage(line)),
      ...cause,
    ];
  } else {
    for (const [index, part] of parts.entries()) {
      if (index === 0 && Predicate.isString(part)) {
        message = cleanMessage(part);
      } else if (Cause.isCause(part)) {
        cause = [...cause, ...renderCause(part, home)];
      } else if (Predicate.isObject(part) && !(part instanceof Error)) {
        for (const [key, value] of Object.entries(part)) {
          fields.push(renderField(key, value, home));
        }
      } else if (part instanceof Error) {
        cause = [...cause, ...describeFailure("error", part, home)];
      } else {
        fields.push(["message", REDACTED]);
      }
    }
  }
  const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
  for (const [key, value] of Object.entries(annotations)) {
    fields.push(renderField(key, value, home));
  }
  const logSpans = options.fiber.getRef(References.CurrentLogSpans);
  const innermost = logSpans.at(0);
  return {
    cause,
    date: options.date,
    durationMs:
      innermost === undefined
        ? undefined
        : Math.max(0, options.date.getTime() - innermost[1]),
    fields,
    level: severity(options.logLevel),
    message,
    span,
  };
};

/** The record a worker sends to its parent process. */
export const toRelayedRecord = (record: SafeRecord): RelayedRecord => {
  const relayed = {
    cause: record.cause,
    fields: record.fields,
    level: record.level,
    message: record.message,
  } satisfies RelayedRecord;
  return record.span === undefined
    ? relayed
    : Object.assign(relayed, { span: record.span });
};

/* -------------------------------------------------------------------------- */
/* Workers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A worker process's loggers. Each record passes the allowlist in the worker
 * and goes to `send`, which writes it on the worker's protocol channel; the
 * parent logs it with `relayWorkerRecord`, so one process tree keeps one
 * Diagnostic Log.
 */
export const makeWorkerLoggerLayer = (
  send: (record: RelayedRecord) => void,
  home: string
) =>
  Layer.mergeAll(
    Logger.layer([
      Logger.make((options) => {
        send(toRelayedRecord(toSafeRecord(options, home)));
      }),
    ]),
    Layer.succeed(References.MinimumLogLevel, "Debug")
  );

/** Logs a worker's record in this process, tagged with the worker's name. */
export const relayWorkerRecord = (worker: string, record: RelayedRecord) =>
  Effect.logWithLevel(record.level)(new Relayed(record)).pipe(
    Effect.annotateLogs({ worker })
  );

/* -------------------------------------------------------------------------- */
/* Formats                                                                    */
/* -------------------------------------------------------------------------- */

const LEVEL_WORD: Readonly<Record<LogLevel.Severity, string>> = {
  Debug: "debug",
  Error: "error",
  Fatal: "fatal",
  Info: "info",
  Trace: "trace",
  Warn: "warning",
};

const LEVEL_COLOR: Readonly<Record<LogLevel.Severity, string>> = {
  Debug: "2",
  Error: "31",
  Fatal: "1;31",
  Info: "36",
  Trace: "2",
  Warn: "33",
};

const color = (text: string, sgr: string, enabled: boolean) =>
  enabled ? `\u001B[${sgr}m${text}\u001B[0m` : text;

const quote = (value: string) =>
  /[\s"=]/u.test(value) ? JSON.stringify(value) : value;

const fieldText = (fields: readonly SafeField[]) =>
  fields.map(([key, value]) => `${key}=${quote(value)}`).join("  ");

const ID_LABELS: ReadonlyMap<string, string> = new Map([
  ["runId", "run"],
  ["sessionId", "session"],
]);

/** The default terminal line: a short sentence, then its fields. */
export const formatPlain = (record: SafeRecord): string => {
  const fields = fieldText(record.fields);
  const head = `contingency: ${LEVEL_WORD[record.level]}: ${record.message}`;
  const summary = record.cause.at(0);
  return [
    fields === "" ? head : `${head}  ${fields}`,
    ...(summary === undefined ? [] : [`  ${summary}`]),
  ].join("\n");
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const clockTime = (date: Date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}`;

/**
 * One line per record, for `--debug` and the Diagnostic Log: time, level,
 * span, the session or Run, the message, the other fields, and the time since
 * the innermost log span started. The cause follows, indented.
 */
export const formatCompact = (
  record: SafeRecord,
  options: { readonly colors: boolean; readonly isoTime: boolean }
): string => {
  const time = options.isoTime
    ? record.date.toISOString()
    : clockTime(record.date);
  const level = color(
    record.level.toUpperCase().padEnd(5),
    LEVEL_COLOR[record.level],
    options.colors
  );
  const span = color((record.span ?? "-").padEnd(24), "2", options.colors);
  const ids = record.fields.filter(([key]) => ID_LABELS.has(key));
  const rest = record.fields.filter(([key]) => !ID_LABELS.has(key));
  const subject = ids
    .map(([key, value]) => `${ID_LABELS.get(key) ?? key}=${value}`)
    .join(" ");
  const body =
    subject === "" ? record.message : `${subject} · ${record.message}`;
  const fields = fieldText(rest);
  const duration =
    record.durationMs === undefined ? "" : `  ${record.durationMs}ms`;
  const head = `${time} ${level} ${span} ${body}${fields === "" ? "" : `  ${fields}`}${duration}`;
  return [head, ...record.cause.map((line) => `    ${line}`)].join("\n");
};

/* -------------------------------------------------------------------------- */
/* File sink                                                                  */
/* -------------------------------------------------------------------------- */

export const DIAGNOSTIC_LOG_DIRECTORY = "logs";
export const DIAGNOSTIC_LOG_MAX_FILES = 20;
export const DIAGNOSTIC_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * `2026-11-24T12-03-04-512Z-4242-0000.log`: when the part started, the
 * process, and the part, padded so names sort oldest first.
 */
export const diagnosticLogFileName = (date: Date, pid: number, part = 0) =>
  `${date.toISOString().replaceAll(":", "-").replace(".", "-")}-${pid}-${String(part).padStart(4, "0")}.log`;

/** Keeps the newest `keep` log files in `directory`, removing the rest. */
const pruneLogs = (directory: string, keep: number) =>
  Effect.gen(function* pruneLogsEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const entries = yield* fileSystem.readDirectory(directory);
    const logs = entries.filter((entry) => entry.endsWith(".log")).toSorted();
    for (const stale of logs.slice(0, Math.max(0, logs.length - keep))) {
      yield* fileSystem.remove(path.join(directory, stale), { force: true });
    }
  });

interface DiagnosticLogFileOptions {
  readonly directory: string;
  readonly maxBytes?: number | undefined;
  readonly maxFiles?: number | undefined;
  readonly now: Date;
  readonly pid: number;
}

/**
 * Appends batches of lines to this process's Diagnostic Log in `directory`.
 * It keeps at most `maxFiles` files of about `maxBytes` each, starting a new
 * file when one fills. Writing never fails the process: a batch the disk
 * refuses is dropped, and the next batch retries.
 */
export const makeDiagnosticLogWriter = (options: DiagnosticLogFileOptions) =>
  Effect.gen(function* makeDiagnosticLogWriterEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const maxBytes = options.maxBytes ?? DIAGNOSTIC_LOG_MAX_BYTES;
    const maxFiles = options.maxFiles ?? DIAGNOSTIC_LOG_MAX_FILES;
    const encoder = new TextEncoder();
    let part = 0;
    let written = 0;
    let file = path.join(
      options.directory,
      diagnosticLogFileName(options.now, options.pid)
    );
    const ready = yield* fileSystem
      .makeDirectory(options.directory, { recursive: true })
      .pipe(
        Effect.andThen(pruneLogs(options.directory, maxFiles - 1)),
        Effect.as(true),
        // The log is evidence, not a precondition: a home directory the
        // process cannot write leaves it without a file, never without a run.
        Effect.orElseSucceed(() => false)
      );
    // A part is named for when it starts, so a long-running process's new
    // part sorts after other processes' newer files, and pruning, which
    // leaves room for it, removes only files older than it.
    const rotate = Effect.gen(function* rotateEffect() {
      part += 1;
      written = 0;
      const startedAt = new Date(yield* Clock.currentTimeMillis);
      file = path.join(
        options.directory,
        diagnosticLogFileName(startedAt, options.pid, part)
      );
      yield* pruneLogs(options.directory, maxFiles - 1);
    });
    return (lines: readonly string[]) =>
      Effect.gen(function* flushEffect() {
        if (!ready || lines.length === 0) {
          return;
        }
        const bytes = encoder.encode(`${lines.join("\n")}\n`);
        if (written > 0 && written + bytes.byteLength > maxBytes) {
          yield* rotate;
        }
        yield* fileSystem.writeFile(file, bytes, { flag: "a" });
        written += bytes.byteLength;
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.orElseSucceed(constVoid)
      );
  });

/**
 * A logger that appends formatted records to this process's Diagnostic Log,
 * in batches, and flushes when its scope closes.
 */
export const makeDiagnosticLogFile = (
  options: DiagnosticLogFileOptions & {
    readonly format: (options: Logger.Options<unknown>) => string;
    readonly window?: `${number} millis` | undefined;
  }
) =>
  Effect.gen(function* makeDiagnosticLogFileEffect() {
    const flush = yield* makeDiagnosticLogWriter(options);
    return yield* Logger.batched(Logger.make(options.format), {
      flush,
      window: options.window ?? "250 millis",
    });
  });
