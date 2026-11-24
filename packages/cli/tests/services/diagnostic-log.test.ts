import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, FileSystem, Layer, Logger, References } from "effect";
import { TestClock } from "effect/testing";

import {
  diagnosticLogFileName,
  formatCompact,
  formatPlain,
  makeDiagnosticLogFile,
  makeDiagnosticLogWriter,
  makeWorkerLoggerLayer,
  REDACTED,
  relayWorkerRecord,
  renderCause,
  tildePath,
  toSafeRecord,
} from "../../src/services/diagnostic-log.ts";
import type {
  RelayedRecord,
  SafeRecord,
} from "../../src/services/diagnostic-log.ts";

const HOME = "/Users/someone";
const SECRET = "hunter2";

/** Runs `effect` and returns every record it logged, after the allowlist. */
const capture = <A, E>(effect: Effect.Effect<A, E>, home = HOME) =>
  Effect.gen(function* captureRecords() {
    const records: SafeRecord[] = [];
    const logger = Logger.make((options) => {
      records.push(toSafeRecord(options, home));
    });
    yield* effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([logger]),
          Layer.succeed(References.MinimumLogLevel, "Trace")
        )
      )
    );
    return records;
  });

class BoomError extends Error {
  readonly _tag = "Boom";
  readonly code = "E_BOOM";
  override readonly name = "BoomError";
}

describe("the allowlist", () => {
  it.effect("renders known kinds and redacts everything else", () =>
    Effect.gen(function* knownKinds() {
      const [record] = yield* capture(
        Effect.logWarning("Opened a page", {
          count: "3",
          file: `${HOME}/shop/.contingency/flow.json?token=${SECRET}`,
          sessionId: `session ${SECRET}`,
          typed: SECRET,
          url: `https://shop.test:8443/cart?password=${SECRET}`,
        })
      );
      expect(record?.message).toBe("Opened a page");
      expect(record?.fields).toEqual([
        ["count", REDACTED],
        ["file", "~/shop/.contingency/flow.json"],
        ["sessionId", REDACTED],
        ["typed", REDACTED],
        ["url", "shop.test:8443"],
      ]);
      expect(JSON.stringify(record)).not.toContain(SECRET);
    })
  );

  it.effect("redacts a value logged as a later message part", () =>
    Effect.gen(function* laterParts() {
      const [record] = yield* capture(
        Effect.logInfo("Filled a field", SECRET, 42)
      );
      expect(record?.fields).toEqual([
        ["message", REDACTED],
        ["message", REDACTED],
      ]);
      expect(JSON.stringify(record)).not.toContain(SECRET);
    })
  );

  it.effect("renders annotations and an error by tag and code", () =>
    Effect.gen(function* annotations() {
      const [record] = yield* capture(
        Effect.logError("Device failed", {
          error: new BoomError(SECRET),
        }).pipe(Effect.annotateLogs({ platform: "ios", udid: "ABC-123" }))
      );
      expect(record?.fields).toEqual([
        ["error", "Boom(E_BOOM)"],
        ["platform", "ios"],
        ["udid", "ABC-123"],
      ]);
    })
  );

  it.effect(
    "renders a code interpreter's process report, but not its exit text",
    () =>
      Effect.gen(function* processReport() {
        const [record] = yield* capture(
          Effect.logDebug("Code interpreter process", {
            bytesToInterpreter: 120,
            exit: `ENOENT ${HOME}/secret-${SECRET}`,
            lastMemory: { heapUsedBytes: 10, rss: 20 },
            startupMs: 35,
          })
        );
        expect(record?.fields).toEqual([
          ["bytesToInterpreter", "120"],
          ["exit", REDACTED],
          ["lastMemory", "heapUsedBytes:10,rss:20"],
          ["startupMs", "35"],
        ]);
      })
  );

  it("replaces only the home directory itself with ~", () => {
    expect(tildePath(`${HOME}/a`, HOME)).toBe("~/a");
    expect(tildePath(HOME, HOME)).toBe("~");
    expect(tildePath(`${HOME}-other/a`, HOME)).toBe(`${HOME}-other/a`);
    expect(tildePath("/a", "/")).toBe("/a");
  });
});

describe("causes", () => {
  const packageRoot = path.resolve(import.meta.dirname, "../..");

  it("keeps a failure's tag, code, and frames, never its message", () => {
    const lines = renderCause(Cause.fail(new BoomError(SECRET)), packageRoot);
    expect(lines[0]).toBe("fail Boom(E_BOOM)");
    const frames = lines.slice(1);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((line) => line.startsWith("  at "))).toBe(true);
    expect(
      frames.some((line) =>
        line.includes("~/tests/services/diagnostic-log.test.ts")
      )
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(packageRoot);
  });

  it("follows a defect's cause chain", () => {
    const outer = new Error(`outer ${SECRET}`, {
      cause: new BoomError(SECRET),
    });
    const lines = renderCause(Cause.die(outer), HOME);
    expect(lines[0]).toBe("die Error");
    expect(lines.at(-1)).toBe("  caused by Boom(E_BOOM)");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("names a reason's tag, never its message", () => {
    const error = {
      _tag: "HttpServerError",
      reason: { _tag: "RouteNotFound", message: SECRET },
    };
    expect(renderCause(Cause.fail(error), HOME)).toEqual([
      "fail HttpServerError.RouteNotFound",
    ]);
  });

  it("names an interruption", () => {
    expect(renderCause(Cause.interrupt(), HOME)).toEqual(["interrupted"]);
  });

  it.effect("renders a Cause passed as a message part", () =>
    Effect.gen(function* causePart() {
      const [record] = yield* capture(
        Effect.logError("Run failed", Cause.fail({ _tag: "Refused", code: 7 }))
      );
      expect(record?.cause).toEqual(["fail Refused(7)"]);
      expect(record?.fields).toEqual([]);
    })
  );
});

describe("spans", () => {
  it.effect("records the tracing span and the log span's duration", () =>
    Effect.gen(function* spans() {
      const [record] = yield* capture(
        TestClock.adjust("40 millis").pipe(
          Effect.andThen(Effect.logDebug("Response sent")),
          Effect.withLogSpan("http"),
          Effect.withSpan("session.open")
        )
      );
      expect(record?.span).toBe("session.open");
      expect(record?.durationMs).toBe(40);
    })
  );
});

describe("workers", () => {
  it.effect("relays a worker's record through the allowlist again", () =>
    Effect.gen(function* relay() {
      const sent: RelayedRecord[] = [];
      yield* Effect.logWarning("Stream stopped", {
        reason: "lost",
        typed: SECRET,
      }).pipe(
        Effect.withSpan("android.stream"),
        Effect.provide(
          makeWorkerLoggerLayer((record) => {
            sent.push(record);
          }, HOME)
        )
      );
      expect(sent).toEqual([
        {
          cause: [],
          fields: [
            ["reason", "lost"],
            ["typed", REDACTED],
          ],
          level: "Warn",
          message: "Stream stopped",
          span: "android.stream",
        },
      ]);
      const forged: RelayedRecord = {
        cause: [],
        fields: [
          ["url", `https://shop.test/cart?password=${SECRET}`],
          ["typed", SECRET],
        ],
        level: "Error",
        message: "Stream stopped",
      };
      const records = yield* capture(
        Effect.forEach([...sent, forged], (record) =>
          relayWorkerRecord("android-stream", record)
        )
      );
      expect(records.map((record) => [record.level, record.span])).toEqual([
        ["Warn", "android.stream"],
        ["Error", undefined],
      ]);
      expect(records[0]?.fields).toEqual([
        ["reason", "lost"],
        ["typed", REDACTED],
        ["worker", "android-stream"],
      ]);
      expect(records[1]?.fields).toEqual([
        ["url", "shop.test"],
        ["typed", REDACTED],
        ["worker", "android-stream"],
      ]);
      expect(JSON.stringify(records)).not.toContain(SECRET);
    })
  );
});

describe("formats", () => {
  const record: SafeRecord = {
    cause: ["fail Boom(E_BOOM)", "  at run (~/a.ts:1:1)"],
    date: new Date("2026-11-24T12:03:04.512Z"),
    durationMs: 40,
    fields: [
      ["reason", "lost"],
      ["sessionId", "s1"],
      ["flow", "Check out"],
    ],
    level: "Warn",
    message: "Stream stopped",
    span: "android.stream",
  };

  it("plain: one sentence, its fields, and the cause's first line", () => {
    expect(formatPlain(record)).toBe(
      'contingency: warning: Stream stopped  reason=lost  sessionId=s1  flow="Check out"\n  fail Boom(E_BOOM)'
    );
    expect(formatPlain({ ...record, cause: [], fields: [] })).toBe(
      "contingency: warning: Stream stopped"
    );
  });

  it("compact: time, level, span, subject, fields, duration, then the cause", () => {
    expect(formatCompact(record, { colors: false, isoTime: true })).toBe(
      [
        `2026-11-24T12:03:04.512Z WARN  ${"android.stream".padEnd(24)} session=s1 · Stream stopped  reason=lost  flow="Check out"  40ms`,
        "    fail Boom(E_BOOM)",
        "      at run (~/a.ts:1:1)",
      ].join("\n")
    );
  });

  it("compact colours only the level and span", () => {
    const line = formatCompact(
      { ...record, cause: [], span: undefined },
      { colors: true, isoTime: true }
    );
    expect(line).toContain("\u001B[33mWARN \u001B[0m");
    expect(line).toContain(`\u001B[2m${"-".padEnd(24)}\u001B[0m`);
  });
});

/** Runs `body` with a disposable Diagnostic Log directory. */
const inDirectory = <A, E>(
  body: (input: {
    readonly directory: string;
    readonly fileSystem: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>
) =>
  Effect.gen(function* prepare() {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-diagnostic-log-",
    });
    return yield* body({ directory: path.join(root, "logs"), fileSystem });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("the Diagnostic Log file", () => {
  const NOW = new Date("2026-11-24T12:03:04.512Z");

  it("names files so they sort oldest first", () => {
    expect(diagnosticLogFileName(NOW, 42)).toBe(
      "2026-11-24T12-03-04-512Z-42-0000.log"
    );
    expect(diagnosticLogFileName(NOW, 42, 2)).toBe(
      "2026-11-24T12-03-04-512Z-42-0002.log"
    );
  });

  it.effect("starts a new file when one fills and keeps the newest", () =>
    inDirectory(({ directory, fileSystem }) =>
      Effect.gen(function* rotation() {
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        for (const old of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
          yield* fileSystem.writeFileString(
            path.join(directory, `${old}T00-00-00-000Z-1.log`),
            "old\n"
          );
        }
        yield* fileSystem.writeFileString(
          path.join(directory, "notes.txt"),
          "kept"
        );
        const write = yield* makeDiagnosticLogWriter({
          directory,
          maxBytes: 13,
          maxFiles: 3,
          now: NOW,
          pid: 42,
        });
        // Startup leaves room for this process's file.
        expect((yield* fileSystem.readDirectory(directory)).toSorted()).toEqual(
          [
            "2026-01-02T00-00-00-000Z-1.log",
            "2026-01-03T00-00-00-000Z-1.log",
            "notes.txt",
          ]
        );
        yield* TestClock.setTime(NOW.getTime());
        yield* write(["first"]);
        yield* write(["second"]);
        yield* write(["third"]);
        yield* write([]);
        expect((yield* fileSystem.readDirectory(directory)).toSorted()).toEqual(
          [
            "2026-01-03T00-00-00-000Z-1.log",
            diagnosticLogFileName(NOW, 42),
            diagnosticLogFileName(NOW, 42, 1),
            "notes.txt",
          ]
        );
        const read = (part: number) =>
          fileSystem.readFileString(
            path.join(directory, diagnosticLogFileName(NOW, 42, part))
          );
        expect(yield* read(0)).toBe("first\nsecond\n");
        expect(yield* read(1)).toBe("third\n");
      })
    )
  );

  it.effect("a long-running process never evicts newer processes' logs", () =>
    inDirectory(({ directory, fileSystem }) =>
      Effect.gen(function* olderProcessRotates() {
        const write = yield* makeDiagnosticLogWriter({
          directory,
          maxBytes: 13,
          maxFiles: 3,
          now: NOW,
          pid: 42,
        });
        yield* write(["first"]);
        // Three newer processes start while this one runs; the first of them
        // pruned this process's first part to make room.
        yield* fileSystem.remove(
          path.join(directory, diagnosticLogFileName(NOW, 42))
        );
        const hour = 60 * 60 * 1000;
        const at = (hours: number) => new Date(NOW.getTime() + hours * hour);
        const newer = [1, 2, 3].map((hours) =>
          diagnosticLogFileName(at(hours), 7 + hours)
        );
        for (const file of newer) {
          yield* fileSystem.writeFileString(
            path.join(directory, file),
            "newer\n"
          );
        }
        yield* TestClock.setTime(at(4).getTime());
        yield* write(["second", "third"]);
        // The new part is the newest file, so only the oldest is pruned, and
        // the next process to start prunes the oldest again, never this part.
        expect((yield* fileSystem.readDirectory(directory)).toSorted()).toEqual(
          [newer[1], newer[2], diagnosticLogFileName(at(4), 42, 1)]
        );
      })
    )
  );

  it.effect("drops a batch the disk refuses", () =>
    inDirectory(({ directory, fileSystem }) =>
      Effect.gen(function* refused() {
        // A file where the directory should be: nothing can be written.
        yield* fileSystem.makeDirectory(path.dirname(directory), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(directory, "");
        const write = yield* makeDiagnosticLogWriter({
          directory,
          now: NOW,
          pid: 42,
        });
        yield* write(["lost"]);
        expect(yield* fileSystem.readFileString(directory)).toBe("");
      })
    )
  );

  it.effect("flushes what it buffered when its scope closes", () =>
    inDirectory(({ directory, fileSystem }) =>
      Effect.gen(function* flushOnClose() {
        yield* Effect.scoped(
          Effect.gen(function* logThenClose() {
            const logger = yield* makeDiagnosticLogFile({
              directory,
              format: (options) =>
                formatCompact(toSafeRecord(options, HOME), {
                  colors: false,
                  isoTime: true,
                }),
              now: NOW,
              pid: 42,
            });
            yield* Effect.logDebug("Response sent", {
              "http.status": 204,
            }).pipe(
              Effect.provide(Logger.layer([logger])),
              Effect.provideService(References.MinimumLogLevel, "Debug")
            );
          })
        );
        const text = yield* fileSystem.readFileString(
          path.join(directory, diagnosticLogFileName(NOW, 42))
        );
        expect(text).toMatch(/ DEBUG .* Response sent {2}http\.status=204\n$/u);
      })
    )
  );
});
