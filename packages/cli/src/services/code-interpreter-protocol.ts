import { Schema } from "effect";

/**
 * The process boundary between Contingency's server and the OpenCode
 * interpreter process, a feasibility prototype for ADR 0059 (#459).
 *
 * Every message is one line of JSON. The server writes to the interpreter's
 * stdin; the interpreter writes to its stdout. Its watchdog thread reports
 * memory on fd 3 so a blocked interpreter thread cannot silence it. Both sides
 * decode with excess properties refused, so a message carrying anything the
 * protocol does not declare is malformed rather than silently trimmed.
 */

export const strictDecode = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const { Json } = Schema;

/** One operation the server lets a program request, with its signature. */
export const InterpreterOperation = Schema.Struct({
  description: Schema.String,
  /** A render-only JSON Schema; the server validates the input again. */
  inputSchema: Json,
  name: Schema.String.check(Schema.isMinLength(1)),
});

export const InterpreterProgramLimits = Schema.Struct({
  maxOutputBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The interpreter's own cooperative deadline, inside the server's. */
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});

/** Server → interpreter: run one program, then exit. */
export const ExecuteMessage = Schema.Struct({
  code: Schema.String,
  limits: InterpreterProgramLimits,
  operations: Schema.Array(InterpreterOperation),
  type: Schema.Literal("execute"),
});

/** Server → interpreter: the answer to one operation request. */
export const OperationResultMessage = Schema.Struct({
  id: Schema.Int,
  outcome: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), value: Json }),
    Schema.Struct({ message: Schema.String, ok: Schema.Literal(false) }),
  ]),
  type: Schema.Literal("result"),
});

/**
 * Server → interpreter: stop the program now. The server kills the process
 * after a grace period whether or not the interpreter obeys.
 */
export const CancelMessage = Schema.Struct({
  reason: Schema.Literals(["cancelled", "intervention"]),
  type: Schema.Literal("cancel"),
});

export const ServerMessage = Schema.Union([
  ExecuteMessage,
  OperationResultMessage,
  CancelMessage,
]);

export const MemoryUsage = Schema.Struct({
  arrayBuffersBytes: Schema.Number,
  heapUsedBytes: Schema.Number,
  rssBytes: Schema.Number,
});

/** Interpreter → server: the process loaded and awaits a program. */
export const ReadyMessage = Schema.Struct({
  heapLimitBytes: Schema.Number,
  type: Schema.Literal("ready"),
});

/** Interpreter → server: a program asked for one operation. */
export const OperationRequestMessage = Schema.Struct({
  id: Schema.Int,
  input: Json,
  operation: Schema.String,
  type: Schema.Literal("call"),
});

const Diagnostic = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
});

/** Interpreter → server: the program finished, and the process will exit. */
export const DoneMessage = Schema.Struct({
  error: Schema.optionalKey(Diagnostic),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  memory: MemoryUsage,
  ok: Schema.Boolean,
  truncated: Schema.optionalKey(Schema.Boolean),
  type: Schema.Literal("done"),
  value: Schema.optionalKey(Json),
});

export const InterpreterMessage = Schema.Union([
  ReadyMessage,
  OperationRequestMessage,
  DoneMessage,
]);

/** Watchdog → server on fd 3: a sample, or why it is killing the process. */
export const WatchdogMessage = Schema.Union([
  Schema.Struct({ memory: MemoryUsage, type: Schema.Literal("sample") }),
  Schema.Struct({
    memory: MemoryUsage,
    type: Schema.Literal("rss_ceiling"),
  }),
  Schema.Struct({ type: Schema.Literal("orphaned") }),
]);

/** What the watchdog thread enforces, passed as the process's argument. */
export const WatchdogOptions = Schema.Struct({
  intervalMs: Schema.Int.check(Schema.isGreaterThan(0)),
  rssCeilingBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type OfferedOperation = typeof InterpreterOperation.Type;
export type ServerInstruction = typeof ServerMessage.Type;
export type InterpreterReport = typeof InterpreterMessage.Type;
export type MemoryReading = typeof MemoryUsage.Type;

/** One protocol message as the line that carries it. */
export const encodeLine = (message: ServerInstruction | InterpreterReport) =>
  `${JSON.stringify(message)}\n`;
