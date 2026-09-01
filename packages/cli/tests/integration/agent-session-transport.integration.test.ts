import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

import {
  AgentSessionId,
  ContingencyRpcs,
  OperationId,
} from "@contingency/protocol";
import {
  NodeHttpServer,
  NodeServices,
  NodeSocket,
} from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { Socket } from "effect/unstable/socket";

import { makeRpcRoutes } from "../../src/routes/rpc.ts";
import {
  defaultAgentResourceDirectory,
  prepareAgentResourceDirectory,
} from "../../src/services/agent-session-resources.ts";
import {
  makeAgentSessionLayer,
  AgentSession,
} from "../../src/services/agent-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { RunSession } from "../../src/services/run-session.ts";
import type { RunSessionService } from "../../src/services/run-session.ts";

const viewport = {
  deviceScaleFactor: 1,
  height: 480,
  width: 640,
} as const;

const runSession: RunSessionService = {
  answerVariable: () => Effect.die("Not under test."),
  artifactPath: () => Effect.die("Not under test."),
  changes: () => Stream.never,
  get: () => Effect.succeed(null),
  loadFlow: () => Effect.die("Not under test."),
  start: () => Effect.die("Not under test."),
};

const reservePort = Effect.promise(
  () =>
    // oxlint-disable-next-line promise/avoid-new -- Bridges the Node server callback in this test.
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Could not reserve a loopback port."));
          return;
        }
        probe.close((cause) =>
          cause === undefined ? resolve(address.port) : reject(cause)
        );
      });
    })
);

const makeLoopbackRpcClient = (origin: string) =>
  Effect.gen(function* makeLoopbackClient() {
    const socketConstructor = Layer.succeed(
      Socket.WebSocketConstructor,
      ((url: string, protocols?: string | string[]) =>
        new NodeSocket.NodeWS.WebSocket(url, protocols, {
          origin,
        })) as unknown as Socket.WebSocketConstructor["Service"]
    );
    const socket = Layer.effect(Socket.Socket)(
      Socket.makeWebSocket(`${origin.replace("http", "ws")}/ws`).pipe(
        Effect.provide(socketConstructor)
      )
    );
    const clientLayer = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(socketConstructor)
    );
    const clientContext = yield* Layer.build(clientLayer);
    return yield* RpcClient.make(ContingencyRpcs, {
      flatten: true,
    }).pipe(Effect.provideContext(clientContext));
  });

it.live(
  "uses real loopback HTTP/WebSocket RPC for two real Chromium Agent Sessions",
  () =>
    Effect.gen(function* publicAgentViewTransport() {
      const port = yield* reservePort;
      const origin = `http://127.0.0.1:${port}`;
      const fileSystem = yield* FileSystem.FileSystem;
      const ownerMarker = yield* prepareAgentResourceDirectory(
        defaultAgentResourceDirectory()
      );
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(ownerMarker, { recursive: true }).pipe(Effect.ignore)
      );
      const browserServices = Layer.mergeAll(
        makeAgentSessionLayer({
          baseUrl: origin,
          resourceDirectory: ownerMarker,
        }),
        RecordingLive
      ).pipe(
        Layer.provideMerge(CreateBrowserLive),
        Layer.provideMerge(NodeServices.layer)
      );
      const serverContext = yield* Layer.build(
        HttpRouter.serve(
          makeRpcRoutes({
            allowedOrigins: new Set([origin]),
            runSession: Layer.succeed(RunSession, runSession),
          })
        ).pipe(
          Layer.provideMerge(browserServices),
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, {
              host: "127.0.0.1",
              port,
            })
          )
        )
      );
      const server = Context.get(serverContext, HttpServer.HttpServer);
      expect(server.address._tag).toBe("TcpAddress");

      yield* Effect.promise(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Bridges the Node WebSocket callback in this test.
          new Promise<void>((resolve, reject) => {
            const probe = new NodeSocket.NodeWS.WebSocket(
              `${origin.replace("http", "ws")}/ws`,
              undefined,
              { origin }
            );
            probe.once("open", () => {
              probe.close();
              resolve();
            });
            probe.once("error", reject);
          })
      ).pipe(Effect.timeout("2 seconds"));

      const client = yield* makeLoopbackRpcClient(origin);

      const start = (name: string, operationId: string) =>
        client("agent.session.start", {
          data: {
            activity: "run",
            clientName: "transport-test",
            clientVersion: "1",
            name,
            operationId: OperationId.make(operationId),
            url: `data:text/html,<title>${name}</title><main>${name}</main>`,
            viewport,
          },
          type: "agent.session.start",
        }).pipe(Effect.timeout("10 seconds"));
      const first = yield* start("first", "transport-start-first");
      const second = yield* start("second", "transport-start-second");
      const firstSession = first.data.session;
      const secondSession = second.data.session;
      expect(firstSession.id).not.toBe(secondSession.id);

      const firstFrame = (sessionId: AgentSessionId) =>
        Effect.scoped(
          client(
            "agent.browser.stream.subscribe",
            {
              data: { sessionId },
              type: "agent.browser.stream.subscribe",
            },
            { headers: { origin } }
          ).pipe(
            Stream.filter((event) => event.type === "frame"),
            Stream.runHead,
            Effect.flatMap((result) =>
              result._tag === "Some"
                ? Effect.succeed(result.value)
                : Effect.die("The Agent Session stream ended before a frame.")
            ),
            Effect.timeout("10 seconds")
          )
        );
      const firstEvent = yield* firstFrame(firstSession.id);
      const secondEvent = yield* firstFrame(secondSession.id);
      expect(firstEvent.data.length).toBeGreaterThan(0);
      expect(secondEvent.data.length).toBeGreaterThan(0);
      yield* client(
        "agent.browser.frame.ack",
        {
          data: {
            frameId: firstEvent.seq,
            sessionId: firstSession.id,
            streamId: firstEvent.streamId,
          },
          type: "agent.browser.frame.ack",
        },
        { headers: { origin } }
      );
      const closed = yield* client(
        "agent.session.close",
        {
          data: {
            operationId: OperationId.make("transport-close-first"),
            sessionId: firstSession.id,
          },
          type: "agent.session.close",
        },
        { headers: { origin } }
      );
      expect(closed.data.session.phase).toBe("closed");
      const remaining = yield* client(
        "agent.sessions.get",
        { data: {}, type: "agent.sessions.get" },
        { headers: { origin } }
      );
      expect(remaining.data.sessions.map(({ id }) => id)).toEqual([
        secondSession.id,
      ]);

      const agent = Context.get(serverContext, AgentSession);
      yield* agent.closeAll();
      expect((yield* agent.get(secondSession.id)).phase).toBe("interrupted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const MAX_NDJSON_BYTES = 1_048_576;

interface JsonRpcResponse {
  readonly error?: unknown;
  readonly id?: number;
  readonly result?: unknown;
}

interface PendingResponse {
  readonly id: number;
  readonly reject: (cause: Error) => void;
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingText {
  readonly reject: (cause: Error) => void;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface McpChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly receive: (id: number) => Promise<JsonRpcResponse>;
  readonly send: (message: object) => Promise<void>;
  readonly stop: () => Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly waitForText: (text: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const spawnMcpChild = (port: number): McpChild => {
  const child = spawn(
    process.execPath,
    [path.resolve(import.meta.dirname, "../../src/index.ts"), "mcp"],
    {
      env: {
        ...process.env,
        CONTINGENCY_MCP_HOST: "127.0.0.1",
        CONTINGENCY_MCP_PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const responses: JsonRpcResponse[] = [];
  const pendingResponses: PendingResponse[] = [];
  const pendingText: {
    readonly text: string;
    readonly pending: PendingText;
  }[] = [];
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;
  let closeResult:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  let resolveClosed:
    | ((result: {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }) => void)
    | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Bridges the child-process close event in this test.
  const closedPromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    resolveClosed = resolve;
  });

  const failPending = (cause: Error) => {
    while (pendingResponses.length > 0) {
      const pending = pendingResponses.shift();
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        pending.reject(cause);
      }
    }
    while (pendingText.length > 0) {
      const pending = pendingText.shift();
      if (pending !== undefined) {
        clearTimeout(pending.pending.timer);
        pending.pending.reject(cause);
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    if (Buffer.byteLength(stdoutBuffer) > MAX_NDJSON_BYTES) {
      failPending(new Error("MCP stdout exceeded the NDJSON bound."));
      return;
    }
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_NDJSON_BYTES) {
        failPending(new Error("MCP NDJSON line exceeded the bound."));
        return;
      }
      if (line.trim().length > 0) {
        let response: JsonRpcResponse;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isRecord(parsed)) {
            throw new Error("MCP response was not a JSON object.");
          }
          response = parsed as JsonRpcResponse;
        } catch (error) {
          failPending(
            error instanceof Error
              ? error
              : new Error("MCP response was not valid JSON.")
          );
          return;
        }
        const pendingIndex = pendingResponses.findIndex(
          ({ id }) => id === response.id
        );
        if (pendingIndex === -1) {
          responses.push(response);
        } else {
          const [pending] = pendingResponses.splice(pendingIndex, 1);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            pending.resolve(response);
          }
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
    for (let index = pendingText.length - 1; index >= 0; index -= 1) {
      const entry = pendingText[index];
      if (entry !== undefined && stderrBuffer.includes(entry.text)) {
        clearTimeout(entry.pending.timer);
        pendingText.splice(index, 1);
        entry.pending.resolve();
      }
    }
  });
  child.on("error", (cause) => {
    failPending(cause);
  });
  child.on("close", (code, signal) => {
    closed = true;
    closeResult = { code, signal };
    failPending(
      new Error(
        `MCP child exited before the response (${code ?? signal ?? "unknown"}).`
      )
    );
    resolveClosed?.(closeResult);
  });

  return {
    child,
    receive: (id) => {
      const existing = responses.findIndex((response) => response.id === id);
      if (existing !== -1) {
        const [response] = responses.splice(existing, 1);
        return Promise.resolve(response as JsonRpcResponse);
      }
      if (closed) {
        return Promise.reject(
          new Error(`MCP child exited before response ${id}.`)
        );
      }
      // oxlint-disable-next-line promise/avoid-new -- Bridges one bounded child response to Effect.promise.
      return new Promise<JsonRpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pendingResponses.findIndex(
            (pending) => pending.id === id
          );
          if (index !== -1) {
            pendingResponses.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for MCP response ${id}.`));
        }, 15_000);
        pendingResponses.push({ id, reject, resolve, timer });
      });
    },
    send: (message) => {
      const encoded = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(encoded) > MAX_NDJSON_BYTES) {
        return Promise.reject(
          new Error("MCP request exceeded the NDJSON bound.")
        );
      }
      // oxlint-disable-next-line promise/avoid-new -- Bridges the child stdin callback in this test.
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(encoded, (cause) =>
          cause === undefined || cause === null ? resolve() : reject(cause)
        );
      });
    },
    stop: () => {
      if (closed) {
        return Promise.resolve(
          closeResult as {
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }
        );
      }
      child.kill("SIGTERM");
      return closedPromise;
    },
    waitForText: (text) => {
      if (stderrBuffer.includes(text)) {
        return Promise.resolve();
      }
      if (closed) {
        return Promise.reject(new Error(`MCP child exited before ${text}.`));
      }
      // oxlint-disable-next-line promise/avoid-new -- Bridges one bounded stderr readiness wait.
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = pendingText.findIndex((entry) => entry.text === text);
          if (index !== -1) {
            pendingText.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for MCP stderr: ${text}.`));
        }, 15_000);
        pendingText.push({ pending: { reject, resolve, timer }, text });
      });
    },
  };
};

const toolResult = (response: JsonRpcResponse): Record<string, unknown> => {
  if (response.error !== undefined || !isRecord(response.result)) {
    throw new Error(`MCP tool call failed: ${JSON.stringify(response)}`);
  }
  return response.result;
};

it.live("serves the real MCP stdio child-process boundary", () =>
  Effect.gen(function* mcpChildBoundary() {
    const port = yield* reservePort;
    const mcp = spawnMcpChild(port);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => mcp.stop()).pipe(
        Effect.timeout("15 seconds"),
        Effect.ignore
      )
    );
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.promise(() =>
      mcp.waitForText(`Agent View available at http://127.0.0.1:${port}/agent`)
    );
    const ownerPid = mcp.child.pid;
    if (ownerPid === undefined) {
      return yield* Effect.die("MCP child did not expose a pid.");
    }
    const ownerMarker = path.join(
      defaultAgentResourceDirectory(),
      `contingency-agent-session-owner-${ownerPid}`
    );
    expect(yield* fileSystem.exists(ownerMarker)).toBe(true);
    const origin = `http://127.0.0.1:${port}`;

    const sendAndReceive = (id: number, method: string, params: object) =>
      Effect.gen(function* sendMcpRequest() {
        yield* Effect.promise(() =>
          mcp.send({ id, jsonrpc: "2.0", method, params })
        );
        return yield* Effect.promise(() => mcp.receive(id));
      });
    const initialized = yield* sendAndReceive(1, "initialize", {
      capabilities: {},
      clientInfo: { name: "transport-test", version: "1" },
      protocolVersion: "2025-06-18",
    });
    expect(initialized.error).toBeUndefined();
    yield* Effect.promise(() =>
      mcp.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })
    );

    const start = (id: number, operationId: string, name: string) =>
      sendAndReceive(id, "tools/call", {
        arguments: {
          clientName: "transport-test",
          clientVersion: "1",
          name,
          operationId,
          url: `data:text/html,<title>${name}</title><main>${name}</main>`,
          viewport,
        },
        name: "agent_session_start",
      });
    const first = toolResult(yield* start(2, "child-start-first", "first"));
    const second = toolResult(yield* start(3, "child-start-second", "second"));
    const firstSnapshot = first.structuredContent;
    const secondSnapshot = second.structuredContent;
    if (!isRecord(firstSnapshot) || !isRecord(secondSnapshot)) {
      return yield* Effect.die(
        "MCP start did not return structured snapshots."
      );
    }
    expect(firstSnapshot.phase).toBe("running");
    expect(secondSnapshot.phase).toBe("running");
    expect(firstSnapshot.id).not.toBe(secondSnapshot.id);
    expect((yield* fileSystem.readDirectory(ownerMarker)).length).toBe(2);

    const firstSessionId = AgentSessionId.make(String(firstSnapshot.id));
    const secondSessionId = AgentSessionId.make(String(secondSnapshot.id));
    yield* Effect.scoped(
      Effect.gen(function* streamChildSessions() {
        const client = yield* makeLoopbackRpcClient(origin);
        const listed = yield* client(
          "agent.sessions.get",
          { data: {}, type: "agent.sessions.get" },
          { headers: { origin } }
        );
        expect(listed.data.sessions.map(({ id }) => id)).toEqual([
          firstSessionId,
          secondSessionId,
        ]);
        const frameFor = (sessionId: AgentSessionId) =>
          Effect.scoped(
            client(
              "agent.browser.stream.subscribe",
              {
                data: { sessionId },
                type: "agent.browser.stream.subscribe",
              },
              { headers: { origin } }
            ).pipe(
              Stream.filter((event) => event.type === "frame"),
              Stream.runHead,
              Effect.flatMap((result) =>
                result._tag === "Some"
                  ? Effect.succeed(result.value)
                  : Effect.die("The Agent Session stream ended before a frame.")
              ),
              Effect.timeout("10 seconds")
            )
          );
        const firstFrame = yield* frameFor(firstSessionId);
        const secondFrame = yield* frameFor(secondSessionId);
        expect(firstFrame.data.length).toBeGreaterThan(0);
        expect(secondFrame.data.length).toBeGreaterThan(0);
        yield* client(
          "agent.browser.frame.ack",
          {
            data: {
              frameId: firstFrame.seq,
              sessionId: firstSessionId,
              streamId: firstFrame.streamId,
            },
            type: "agent.browser.frame.ack",
          },
          { headers: { origin } }
        );
        yield* client(
          "agent.browser.frame.ack",
          {
            data: {
              frameId: secondFrame.seq,
              sessionId: secondSessionId,
              streamId: secondFrame.streamId,
            },
            type: "agent.browser.frame.ack",
          },
          { headers: { origin } }
        );
      })
    );

    const close = (id: number, operationId: string, sessionId: string) =>
      sendAndReceive(id, "tools/call", {
        arguments: { operationId, sessionId },
        name: "agent_session_close",
      });
    const firstClosed = toolResult(
      yield* close(4, "child-close-first", String(firstSessionId))
    );
    expect(
      (firstClosed.structuredContent as Record<string, unknown>).phase
    ).toBe("closed");

    // Keep the second browser live until owner shutdown. The MCP boundary
    // still sees it as running after the first explicit close.
    const live = toolResult(
      yield* sendAndReceive(5, "tools/call", {
        arguments: {},
        name: "agent_sessions_get",
      })
    );
    if (!isRecord(live.structuredContent)) {
      return yield* Effect.die("MCP live-session listing was not structured.");
    }
    const liveSessions = live.structuredContent.sessions;
    if (!Array.isArray(liveSessions)) {
      return yield* Effect.die("MCP live-session listing had no sessions.");
    }
    expect(liveSessions).toHaveLength(1);
    const [liveSession] = liveSessions;
    if (!isRecord(liveSession)) {
      return yield* Effect.die("MCP live-session listing was malformed.");
    }
    expect(liveSession.id).toBe(String(secondSessionId));
    expect(liveSession.phase).toBe("running");

    const liveResourceNames = yield* fileSystem.readDirectory(ownerMarker);
    expect(liveResourceNames).toHaveLength(1);
    const [liveResourceName] = liveResourceNames;
    if (liveResourceName === undefined) {
      return yield* Effect.die("MCP live session had no resource directory.");
    }
    expect(liveResourceName).toMatch(/^session-/u);
    const liveLockPath = path.join(
      ownerMarker,
      liveResourceName,
      "session.lock"
    );
    expect(yield* fileSystem.exists(liveLockPath)).toBe(true);

    const stopped = yield* Effect.promise(() => mcp.stop());
    expect(stopped.signal).toBeNull();
    expect(stopped.code).toBe(130);
    expect(yield* fileSystem.exists(liveLockPath)).toBe(false);
    expect(yield* fileSystem.exists(ownerMarker)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("keeps MCP stdio up when the configured Agent View port is taken", () =>
  Effect.gen(function* occupiedAgentViewPort() {
    const occupiedPort = yield* reservePort;
    const occupier = createServer();
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Bridges the Node listen callback.
          new Promise<void>((resolve, reject) => {
            occupier.once("error", reject);
            occupier.listen(occupiedPort, "127.0.0.1", () => {
              occupier.off("error", reject);
              resolve();
            });
          })
      ),
      () =>
        Effect.promise(
          () =>
            // oxlint-disable-next-line promise/avoid-new -- Bridges the Node close callback.
            new Promise<void>((resolve, reject) => {
              occupier.close((cause) =>
                cause === undefined ? resolve() : reject(cause)
              );
            })
        )
    );
    const mcp = spawnMcpChild(occupiedPort);
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => mcp.stop()).pipe(
        Effect.timeout("15 seconds"),
        Effect.ignore
      )
    );
    yield* Effect.promise(() =>
      mcp.waitForText("Agent View available at http://127.0.0.1:")
    );
    yield* Effect.promise(() =>
      mcp.send({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "occupied-port-test", version: "1" },
          protocolVersion: "2025-06-18",
        },
      })
    );
    const initialized = yield* Effect.promise(() => mcp.receive(1));
    expect(initialized.error).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
