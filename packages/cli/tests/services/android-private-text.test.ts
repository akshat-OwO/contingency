import net from "node:net";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Queue, Redacted } from "effect";

import {
  enterAndroidPrivateText,
  makeAndroidPrivateTextHost,
} from "../../src/services/android-private-text.ts";
import type { AndroidPrivateTextHost } from "../../src/services/android-private-text.ts";
import { androidPrivateTextRelease } from "../../src/services/android-runtime-contract.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import type { PlatformRuntimeError } from "../../src/services/platform-runtime.ts";

const secret = "sentinel-private-value";
const binding = {
  bounds: [42, 1046, 1038, 1186] as const,
  className: "android.widget.EditText",
  focusedWindow: "Window{5fdc67 u0 dev.fixture/dev.fixture.Main}",
  packageName: "dev.fixture",
  password: true,
  resourceId: "dev.fixture:id/password",
};

interface SentMessage {
  readonly id: string;
  readonly op: string;
  readonly target?: unknown;
  readonly value?: string;
}

interface Reply {
  readonly bound?: true;
  readonly error?: string;
  readonly id?: string;
  readonly inputSent?: boolean;
  readonly outcome?: "verified";
}

/** A scripted helper. Every message the host sends or the device receives is journaled. */
const fakeHelper = (options: {
  readonly running?: string;
  readonly ready?: Effect.Effect<number, PlatformRuntimeError>;
  readonly bind?: () => Reply | null;
  readonly fill?: () => Reply | null;
}) => {
  const adbCalls: string[][] = [];
  const instrumentCalls: string[][] = [];
  const sent: SentMessage[] = [];
  const resolutions: string[] = [];
  const host: AndroidPrivateTextHost = {
    adb: (args) =>
      Effect.sync(() => {
        adbCalls.push([...args]);
        if (args[0] === "forward" && args[1] === "tcp:0") {
          return "41000";
        }
        if (args[1]?.startsWith("pidof") && !args[1].includes("force-stop")) {
          return options.running ?? "";
        }
        return "";
      }),
    connect: () =>
      Effect.gen(function* connect() {
        const replies = yield* Queue.unbounded<string, PlatformRuntimeError>();
        return {
          receive: Queue.take(replies),
          send: (line) =>
            Effect.gen(function* send() {
              // SAFETY: the host under test serializes typed requests with JSON.stringify.
              const request = JSON.parse(line) as SentMessage;
              sent.push(request);
              const reply = (
                request.op === "bind" ? options.bind : options.fill
              )?.();
              if (reply === null || reply === undefined) {
                yield* Queue.fail(
                  replies,
                  platformRuntimeError("helper_incompatible")
                );
                return;
              }
              yield* Queue.offer(
                replies,
                JSON.stringify({
                  id: request.id,
                  protocol: androidPrivateTextRelease.protocol,
                  ...reply,
                })
              );
            }),
        };
      }),
    instrument: (args) =>
      Effect.sync(() => {
        instrumentCalls.push([...args]);
        return {
          exited: Effect.void,
          ready: options.ready ?? Effect.succeed(37_000),
        };
      }),
  };
  const value = Effect.sync(() => {
    resolutions.push("resolved");
    return Redacted.make(secret);
  });
  return { adbCalls, host, instrumentCalls, resolutions, sent, value };
};

const enter = (helper: ReturnType<typeof fakeHelper>) =>
  enterAndroidPrivateText(helper.host, {
    binding,
    targetApp: "dev.fixture",
    value: helper.value,
  });

it.effect(
  "binds the field before the value crosses the socket and cleans up its forward and process",
  () =>
    Effect.gen(function* verified() {
      const helper = fakeHelper({
        bind: () => ({ bound: true }),
        fill: () => ({ inputSent: true, outcome: "verified" }),
      });
      yield* enter(helper);
      expect(helper.sent.map((message) => message.op)).toEqual([
        "bind",
        "fill",
      ]);
      expect(helper.sent[0]).toMatchObject({
        target: {
          bounds: [42, 1046, 1038, 1186],
          className: "android.widget.EditText",
          package: "dev.fixture",
          password: true,
          resourceId: "dev.fixture:id/password",
        },
      });
      expect(helper.sent[0]).not.toHaveProperty("value");
      expect(helper.sent[1]).toMatchObject({ value: secret });
      expect(helper.resolutions).toEqual(["resolved"]);
      const commands = JSON.stringify([
        helper.adbCalls,
        helper.instrumentCalls,
      ]);
      expect(commands).not.toContain(secret);
      expect(helper.instrumentCalls[0]?.at(-1)).toBe(
        androidPrivateTextRelease.instrumentation
      );
      expect(helper.adbCalls).toContainEqual([
        "forward",
        "--remove",
        "tcp:41000",
      ]);
      expect(helper.adbCalls.at(-1)?.[1]).toContain(
        `am force-stop ${androidPrivateTextRelease.packageName}`
      );
    })
);

it.effect(
  "refuses a changed field or foreground before resolving the value",
  () =>
    Effect.gen(function* refusals() {
      for (const [error, code] of [
        ["field_mismatch", "target_changed"],
        ["foreground_changed", "ownership_unknown"],
        ["unauthorized", "helper_incompatible"],
      ] as const) {
        const helper = fakeHelper({
          bind: () => ({ error, inputSent: false }),
        });
        expect((yield* Effect.flip(enter(helper))).code).toBe(code);
        expect(helper.resolutions).toEqual([]);
        expect(helper.sent.map((message) => message.op)).toEqual(["bind"]);
        expect(helper.adbCalls).toContainEqual([
          "forward",
          "--remove",
          "tcp:41000",
        ]);
      }
    })
);

it.effect(
  "refuses while another helper holds UiAutomation without starting its own",
  () =>
    Effect.gen(function* busy() {
      const running = fakeHelper({ running: "4707" });
      expect((yield* Effect.flip(enter(running))).code).toBe("helper_owned");
      expect(running.instrumentCalls).toEqual([]);
      const raced = fakeHelper({
        ready: Effect.fail(platformRuntimeError("helper_owned")),
      });
      expect((yield* Effect.flip(enter(raced))).code).toBe("helper_owned");
      expect(raced.resolutions).toEqual([]);
      expect(raced.adbCalls.some((args) => args[0] === "forward")).toBe(false);
    })
);

it.effect(
  "reports uncertain input once the value may have reached the device",
  () =>
    Effect.gen(function* uncertain() {
      for (const fill of [
        () => ({ error: "input_unverified", inputSent: true }),
        () => ({ error: "input_failed" }),
        () => null,
      ]) {
        const helper = fakeHelper({ bind: () => ({ bound: true }), fill });
        const failure = yield* Effect.flip(enter(helper));
        expect(failure.code).toBe("private_input_uncertain");
        expect(JSON.stringify(failure)).not.toContain(secret);
        expect(helper.sent.map((message) => message.op)).toEqual([
          "bind",
          "fill",
        ]);
      }
    })
);

it.effect("rejects a response correlated to another request", () =>
  Effect.gen(function* correlation() {
    const helper = fakeHelper({
      bind: () => ({ bound: true, id: "another-request" }),
    });
    expect((yield* Effect.flip(enter(helper))).code).toBe(
      "helper_incompatible"
    );
    expect(helper.resolutions).toEqual([]);
  })
);

it.effect("frames newline-delimited helper responses over a real socket", () =>
  Effect.gen(function* framing() {
    const received = yield* Deferred.make<string>();
    const server = yield* Effect.acquireRelease(
      Effect.callback<net.Server>((resume) => {
        const listening = net.createServer((socket) => {
          socket.once("data", (chunk) => {
            Deferred.doneUnsafe(received, Effect.succeed(chunk.toString()));
            // Split one response across writes and join two in one write.
            socket.write('{"a":');
            socket.write('1}\n{"b":2}\n');
          });
        });
        listening.listen(0, "127.0.0.1", () =>
          resume(Effect.succeed(listening))
        );
      }),
      (owned) => Effect.sync(() => owned.close())
    );
    // SAFETY: a server listening on a TCP port reports AddressInfo, not a pipe path.
    const address = server.address() as net.AddressInfo;
    const host = makeAndroidPrivateTextHost("unused", () => Effect.succeed(""));
    const connection = yield* host.connect(address.port);
    yield* connection.send("hello");
    expect(yield* Deferred.await(received)).toBe("hello\n");
    expect(yield* connection.receive).toBe('{"a":1}');
    expect(yield* connection.receive).toBe('{"b":2}');
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"))
);
