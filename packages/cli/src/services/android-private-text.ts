import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import {
  Cause,
  Deferred,
  Effect,
  Queue,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";

import { androidPrivateTextRelease } from "./android-runtime-contract.ts";
import type { AndroidPrivateTextBinding } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/** Package whose instrumentation holds the one UiAutomation connection during agent-device capture. */
export const agentDeviceSnapshotHelperPackage =
  "com.callstack.agentdevice.snapshothelper";

const readyPattern = new RegExp(
  `INSTRUMENTATION_STATUS: protocol=${androidPrivateTextRelease.protocol}[\\s\\S]*?INSTRUMENTATION_STATUS: port=(?<port>\\d{1,5})|INSTRUMENTATION_STATUS: port=(?<late>\\d{1,5})[\\s\\S]*?INSTRUMENTATION_STATUS: protocol=${androidPrivateTextRelease.protocol}`,
  "u"
);
const maxResponseBytes = 4096;

const HelperResponse = Schema.Struct({
  bound: Schema.optional(Schema.Literal(true)),
  error: Schema.optional(Schema.String),
  id: Schema.String,
  inputSent: Schema.optional(Schema.Boolean),
  outcome: Schema.optional(Schema.Literal("verified")),
  protocol: Schema.Literal(androidPrivateTextRelease.protocol),
});
type HelperReply = typeof HelperResponse.Type;

type HelperRequest =
  | {
      readonly id: string;
      readonly op: "bind";
      readonly target: {
        readonly bounds: AndroidPrivateTextBinding["bounds"];
        readonly className: string;
        readonly package: string;
        readonly password: boolean;
        readonly resourceId: string | null;
      };
    }
  | { readonly id: string; readonly op: "fill"; readonly value: string };

/** The helper process and its status stream. Never carries the value. */
export interface AndroidPrivateTextHelperProcess {
  /** Device port once the helper reports ready; fails if it exits first. */
  readonly ready: Effect.Effect<number, PlatformRuntimeError>;
  readonly exited: Effect.Effect<void>;
}

export interface AndroidPrivateTextConnection {
  readonly send: (line: string) => Effect.Effect<void, PlatformRuntimeError>;
  readonly receive: Effect.Effect<string, PlatformRuntimeError>;
}

/** Device operations, bound to one serial. Tests substitute a fake helper. */
export interface AndroidPrivateTextHost {
  readonly adb: (
    args: readonly string[]
  ) => Effect.Effect<string, PlatformRuntimeError>;
  readonly instrument: (
    args: readonly string[]
  ) => Effect.Effect<
    AndroidPrivateTextHelperProcess,
    PlatformRuntimeError,
    Scope.Scope
  >;
  readonly connect: (
    port: number
  ) => Effect.Effect<
    AndroidPrivateTextConnection,
    PlatformRuntimeError,
    Scope.Scope
  >;
}

const failure = (code: PlatformRuntimeError["code"]) =>
  Effect.fail({
    ...platformRuntimeError(code),
    operation: "private-text" as const,
  });

/** Before any value is sent, a refusal leaves the field untouched. */
const refusal = (error: string | undefined) => {
  switch (error) {
    case "field_mismatch":
    case "window_changed": {
      return Effect.fail({
        ...platformRuntimeError("target_changed"),
        backendReason: error,
        operation: "private-text" as const,
      });
    }
    case "foreground_changed": {
      return failure("ownership_unknown");
    }
    case "automation_busy": {
      return failure("helper_owned");
    }
    default: {
      return failure("helper_incompatible");
    }
  }
};

const decode = (line: string, id: string) =>
  Effect.try({
    catch: () => platformRuntimeError("helper_incompatible"),
    try: (): HelperReply =>
      Schema.decodeUnknownSync(HelperResponse)(JSON.parse(line)),
  }).pipe(
    Effect.flatMap((response) =>
      response.id === id
        ? Effect.succeed(response)
        : failure("helper_incompatible")
    )
  );

export const privateTextInstrumentationArgs = (
  token: string,
  targetApp: string
): readonly string[] => [
  "shell",
  "am",
  "instrument",
  "-w",
  "-r",
  "-e",
  "token",
  token,
  "-e",
  "target",
  targetApp,
  androidPrivateTextRelease.instrumentation,
];

export interface AndroidPrivateTextInput {
  readonly targetApp: string;
  readonly binding: AndroidPrivateTextBinding;
  /** Fails unless the observed window is still focused. */
  readonly requireWindow: Effect.Effect<void, PlatformRuntimeError>;
  readonly value: Effect.Effect<
    Redacted.Redacted<string>,
    PlatformRuntimeError
  >;
}

const enterOnce = (
  host: AndroidPrivateTextHost,
  input: AndroidPrivateTextInput,
  cleanup: (
    effect: Effect.Effect<unknown, PlatformRuntimeError>
  ) => Effect.Effect<void>
) =>
  Effect.gen(function* enterPrivateText() {
    const running = yield* host.adb([
      "shell",
      `pidof ${androidPrivateTextRelease.packageName} ${agentDeviceSnapshotHelperPackage} || true`,
    ]);
    if (running !== "") {
      return yield* failure("helper_owned");
    }
    yield* input.requireWindow;
    const token = randomBytes(24).toString("hex");
    // Registered first, so it runs after the socket and forward are gone.
    yield* Scope.addFinalizer(
      yield* Scope.Scope,
      cleanup(
        host
          .adb([
            "shell",
            "am",
            "force-stop",
            androidPrivateTextRelease.packageName,
          ])
          .pipe(
            Effect.andThen(
              host.adb([
                "shell",
                `pidof ${androidPrivateTextRelease.packageName} || true`,
              ])
            ),
            Effect.flatMap((survivor) =>
              survivor === "" ? Effect.void : failure("cleanup_failed")
            )
          )
      )
    );
    const helper = yield* host.instrument(
      privateTextInstrumentationArgs(token, input.targetApp)
    );
    const devicePort = yield* helper.ready;
    const hostPort = yield* Effect.acquireRelease(
      host
        .adb(["forward", "tcp:0", `tcp:${devicePort}`])
        .pipe(
          Effect.flatMap((output) =>
            /^\d{1,5}$/u.test(output)
              ? Effect.succeed(Number(output))
              : failure("helper_incompatible")
          )
        ),
      (port) => cleanup(host.adb(["forward", "--remove", `tcp:${port}`]))
    );
    const connection = yield* host.connect(hostPort);
    const message = (fields: HelperRequest) =>
      JSON.stringify({
        protocol: androidPrivateTextRelease.protocol,
        token,
        ...fields,
      });
    const bindId = randomUUID();
    yield* connection.send(
      message({
        id: bindId,
        op: "bind",
        target: {
          bounds: input.binding.bounds,
          className: input.binding.className,
          package: input.binding.packageName,
          password: input.binding.password,
          resourceId: input.binding.resourceId,
        },
      })
    );
    const bound = yield* decode(yield* connection.receive, bindId);
    if (bound.bound !== true) {
      return yield* refusal(bound.error);
    }
    // The helper fixed its window at bind; it must still be the observed one.
    yield* input.requireWindow;
    // A Variable that fails to resolve closes the socket; the helper times out without input.
    const value = yield* input.value;
    const fillId = randomUUID();
    const filled = yield* connection
      .send(message({ id: fillId, op: "fill", value: Redacted.value(value) }))
      .pipe(
        Effect.andThen(connection.receive),
        Effect.flatMap((line) => decode(line, fillId)),
        // Once the value may be on the device, every failure is uncertain.
        Effect.mapError(() => ({
          ...platformRuntimeError("private_input_uncertain"),
          operation: "private-text" as const,
        }))
      );
    if (filled.outcome !== "verified") {
      if (filled.inputSent === false) {
        return yield* refusal(filled.error);
      }
      if (
        filled.error === "input_unverified" ||
        filled.error === "input_failed"
      ) {
        return yield* Effect.fail({
          ...platformRuntimeError("private_input_uncertain"),
          backendReason: filled.error,
          operation: "private-text" as const,
        } satisfies PlatformRuntimeError);
      }
      return yield* failure("private_input_uncertain");
    }
    yield* helper.exited.pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.void,
      })
    );
  });

/**
 * Enters one private value through the Contingency helper.
 *
 * Android allows one UiAutomation connection, so this refuses while any
 * helper process runs and holds the device only for this one fill. The value
 * crosses to the device only after the helper has bound the observed field in
 * the observed window, and only over the authenticated, forwarded loopback
 * socket. Failed cleanup is reported as `cleanup_failed`, never hidden.
 */
export const enterAndroidPrivateText = (
  host: AndroidPrivateTextHost,
  input: AndroidPrivateTextInput
): Effect.Effect<void, PlatformRuntimeError> =>
  Effect.gen(function* enterWithCleanup() {
    const cleanupFailed = yield* Ref.make(false);
    // Every cleanup step runs; any failure is retained, not retried.
    const cleanup = (effect: Effect.Effect<unknown, PlatformRuntimeError>) =>
      effect.pipe(Effect.catchCause(() => Ref.set(cleanupFailed, true)));
    const result = yield* Effect.exit(
      Effect.scoped(enterOnce(host, input, cleanup))
    );
    if (yield* Ref.get(cleanupFailed)) {
      return yield* failure("cleanup_failed");
    }
    return yield* result;
  });

/** Real ADB host bound to one serial. Child output never leaves this module. */
export const makeAndroidPrivateTextHost = (
  serial: string,
  adb: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>
): AndroidPrivateTextHost => ({
  adb,
  connect: (port) =>
    Effect.gen(function* connect() {
      const lines = yield* Queue.unbounded<string, PlatformRuntimeError>();
      const socket = yield* Effect.acquireRelease(
        Effect.callback<net.Socket, PlatformRuntimeError>((resume) => {
          const opened = net.connect(port, "127.0.0.1");
          opened.once("connect", () => resume(Effect.succeed(opened)));
          opened.once("error", () => resume(failure("helper_incompatible")));
        }),
        (owned) => Effect.sync(() => owned.destroy())
      );
      const closed = () =>
        Queue.failCauseUnsafe(
          lines,
          Cause.fail(platformRuntimeError("helper_incompatible"))
        );
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf-8");
        // A helper response is small; anything larger is not the helper.
        if (buffered.length > maxResponseBytes) {
          closed();
          socket.destroy();
          return;
        }
        for (
          let newline = buffered.indexOf("\n");
          newline !== -1;
          newline = buffered.indexOf("\n")
        ) {
          Queue.offerUnsafe(lines, buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
        }
      });
      socket.on("close", closed);
      return {
        receive: Queue.take(lines).pipe(
          Effect.mapError(() => ({
            ...platformRuntimeError("helper_incompatible"),
            operation: "private-text" as const,
          }))
        ),
        // A failed write closes the socket, which fails the next receive.
        send: (line) =>
          Effect.try({
            catch: () => platformRuntimeError("helper_incompatible"),
            try: () => {
              socket.write(`${line}\n`);
            },
          }),
      };
    }),
  instrument: (args) =>
    Effect.gen(function* instrument() {
      const ready = yield* Deferred.make<number, PlatformRuntimeError>();
      const exited = yield* Deferred.make<undefined>();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn("adb", ["-s", serial, ...args], {
            stdio: ["ignore", "pipe", "ignore"],
          })
        ),
        (owned) =>
          Effect.sync(() => {
            if (owned.exitCode === null && owned.signalCode === null) {
              owned.kill();
            }
          })
      );
      let status = "";
      child.stdout.on("data", (chunk: Buffer) => {
        status += chunk.toString("utf-8");
        const match = readyPattern.exec(status);
        const port = Number(match?.groups?.port ?? match?.groups?.late);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) {
          Deferred.doneUnsafe(ready, Effect.succeed(port));
        }
      });
      child.once("close", () => {
        Deferred.doneUnsafe(
          ready,
          status.includes("error=automation_busy")
            ? failure("helper_owned")
            : failure("helper_incompatible")
        );
        Deferred.doneUnsafe(exited, Effect.undefined);
      });
      child.once("error", () => {
        Deferred.doneUnsafe(ready, failure("device_disconnected"));
        Deferred.doneUnsafe(exited, Effect.undefined);
      });
      return {
        exited: Deferred.await(exited),
        ready: Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => failure("helper_incompatible"),
          })
        ),
      };
    }),
});
