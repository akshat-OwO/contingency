#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cliRoot = path.resolve(import.meta.dirname, "../../../../packages/cli");
const { Effect } = await import(
  pathToFileURL(
    createRequire(import.meta.url).resolve("effect", { paths: [cliRoot] })
  ).href
);
const directory = process.env.CONTINGENCY_VERIFY_DIR;
assert.ok(directory, "Launch the verification instance first.");
const artifacts = path.resolve(
  import.meta.dirname,
  "../artifacts/claude-channels"
);
const io = (action) => Effect.tryPromise(action);
await Effect.runPromise(
  Effect.gen(function* proveChannelReadback() {
    const instance = yield* io(async () =>
      JSON.parse(await readFile(path.join(directory, "instance.json"), "utf-8"))
    );
    const capture = yield* io(async () => {
      const response = await fetch(`${instance.brokerUrl}channels`);
      return await response.json();
    });
    assert.deepEqual(capture.capabilities.experimental["claude/channel"], {});
    const expected = process.argv[2] ?? "flow-skill-verified";
    const matching = capture.messages.filter((frame) =>
      frame.params.content.includes(expected)
    );
    assert.ok(matching.length > 0, `No ${expected} channel frame received.`);
    const reads = [];
    for (const frame of capture.messages) {
      assert.equal(frame.method, "notifications/claude/channel");
      assert.deepEqual(Object.keys(frame.params).toSorted(), [
        "content",
        "meta",
      ]);
      assert.deepEqual(Object.keys(frame.params.meta).toSorted(), [
        "eventCursor",
        "sessionId",
      ]);
      assert.ok(!frame.params.content.includes("\n"));
      assert.ok(!frame.params.content.includes("PASSWORD"));
    }
    for (const frame of matching) {
      const params = {
        afterCursor: frame.params.meta.eventCursor,
        sessionId: frame.params.meta.sessionId,
        view: "compact",
        waitMs: 0,
      };
      const read = () =>
        io(async () => {
          const response = await fetch(`${instance.brokerUrl}call`, {
            body: JSON.stringify({ params, tool: "agent_session_get" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.ok(!result.isError, JSON.stringify(result));
          return result.structuredContent;
        });
      const first = yield* read();
      const replay = yield* read();
      assert.ok(first.events.some((event) => event.kind === expected));
      assert.deepEqual(replay.events, first.events);
      assert.equal(replay.eventCursor, first.eventCursor);
      reads.push({ first, frame, params, replay });
    }
    yield* io(() => mkdir(artifacts, { recursive: true }));
    yield* io(() =>
      writeFile(
        path.join(artifacts, "channel-readback.json"),
        `${JSON.stringify({ capture, expected, reads }, null, 2)}\n`
      )
    );
    process.stdout.write(`Channel batch and replay proved for ${expected}.\n`);
  })
);
