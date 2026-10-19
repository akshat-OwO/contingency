import { createHash } from "node:crypto";
import path from "node:path";

import { AgentSessionId, BrowserDevtoolsInput } from "@contingency/protocol";
import { Effect, FileSystem, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { AgentSession } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import { AgentSessionFailure, failure } from "./mcp-agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

export const BrowserDevtoolsTools = withStrictParameters(
  Toolkit.make(
    Tool.make("agent_browser_devtools", {
      dependencies: [AgentSession, FlowSkillCatalog, FileSystem.FileSystem],
      description:
        "Observe this browser tab in Interactive Runs, Teaching setup, or Dry Runs. requests filters URL substring, method, inclusive statusMin/statusMax, and resourceType, returning bounded metadata and dropped count. request fetches headers and bounded body by requestId, with bodyTruncated. console includes uncaught errors; clear_console clears retained messages. storage reads current-origin cookies/local/session. Credential headers and cookie values are masked; secret Variables are scrubbed. har_start/har_stop require distinct stable operationId values. Stop returns a redacted HAR file reference inside Catalog Root, never bytes. Capture holds at most 500 entries and 64 KiB per body. emulation_get reads session-wide Emulation. emulation_set sets pageZoom (25–500%) and textScale (50–300% of the 16px default) with a stable operationId, only in agent-held Teaching setup or Interactive Runs. It is refused in Dry Runs and during recording. Omit tabId for Emulation. Available only through agent_code_execute; native and Android do not support it.",
      failure: AgentSessionFailure,
      parameters: Schema.Struct({
        ...BrowserDevtoolsInput.fields,
        sessionId: AgentSessionId,
      }),
      success: Schema.Json,
    })
  )
);

const harFailure = (code: string, message: string) =>
  new AgentSessionFailure({ code, message: `${message} (${code})` });

export const BrowserDevtoolsToolHandlersLive = BrowserDevtoolsTools.toLayer({
  agent_browser_devtools: ({ sessionId, command, tabId }) =>
    Effect.gen(function* observeTab() {
      const sessions = yield* AgentSession;
      yield* sessions.noteAgentActivity(sessionId);
      const value = yield* sessions
        .devtools(sessionId, command, tabId)
        .pipe(Effect.mapError(failure));
      if (command.action !== "har_stop") {
        return value;
      }
      const catalog = yield* FlowSkillCatalog;
      const fs = yield* FileSystem.FileSystem;
      const directory = path.join(catalog.root(), ".devtools");
      const id = createHash("sha256")
        .update(`${sessionId}:${tabId ?? "active"}:${command.operationId}`)
        .digest("hex");
      const file = path.join(directory, `${id}.har`);
      const writeFailure = () =>
        harFailure(
          "agent_devtools_har_write_failed",
          "Could not write the HAR file inside Catalog Root."
        );
      yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(writeFailure));
      yield* fs
        .writeFileString(file, JSON.stringify(value))
        .pipe(Effect.mapError(writeFailure));
      return { format: "har", path: file };
    }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          JSON.stringify(value)
        ).pipe(
          Effect.mapError(() =>
            harFailure(
              "agent_devtools_encode_failed",
              "Could not encode this devtools result as JSON."
            )
          )
        )
      )
    ),
});
