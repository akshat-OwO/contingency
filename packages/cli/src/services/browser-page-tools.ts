import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect, Option, Schema } from "effect";
import type { CDPSession, Page } from "playwright-core";

const failure = (message: string) =>
  makeBrowserRpcError("agent_browser_failed", message);

/**
 * The page clipboard, through an isolated world so page scripts cannot replace
 * `navigator.clipboard`. Headless Chromium keeps its own in-memory clipboard,
 * so this never reads or writes the user's system clipboard.
 */
export const pageClipboard = (
  cdp: CDPSession,
  page: Page,
  text: string | undefined
) =>
  Effect.tryPromise({
    catch: () =>
      failure(
        "Could not use the page clipboard. It needs a secure page origin such as https or localhost."
      ),
    try: async () => {
      // The Clipboard API answers only a focused document.
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send(
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: "contingency-clipboard" }
      );
      const { exceptionDetails, result } = await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        contextId: executionContextId,
        expression:
          text === undefined
            ? "navigator.clipboard.readText()"
            : `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => '')`,
        returnByValue: true,
        userGesture: true,
      });
      const value = Schema.decodeUnknownOption(Schema.String)(result.value);
      if (exceptionDetails !== undefined || Option.isNone(value)) {
        throw new Error(`Clipboard unavailable on ${page.url()}`);
      }
      return value.value;
    },
  });

export type ProfileKind = "trace" | "cpu";

const TRACE_CATEGORIES = [
  "-*",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.screenshot",
  "toplevel",
  "blink.user_timing",
  "latencyInfo",
  "loading",
  "v8.execute",
  "disabled-by-default-v8.cpu_profiler",
];

const tracingComplete = (cdp: CDPSession) => {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  cdp.once("Tracing.tracingComplete", (event) => resolve(event.stream));
  return promise;
};

const readStream = async (cdp: CDPSession, handle: string) => {
  const chunks: string[] = [];
  for (;;) {
    // Each chunk depends on the stream position the previous read left.
    // oxlint-disable-next-line no-await-in-loop
    const chunk = await cdp.send("IO.read", { handle });
    chunks.push(
      chunk.base64Encoded === true
        ? Buffer.from(chunk.data, "base64").toString("utf-8")
        : chunk.data
    );
    if (chunk.eof) {
      break;
    }
  }
  await cdp.send("IO.close", { handle });
  return chunks.join("");
};

/**
 * Start or stop a performance trace or CPU profile on one Page. Stop answers
 * the recorded file contents: Chrome trace event JSON or a `.cpuprofile`.
 */
export const pageProfile = (
  cdp: CDPSession,
  kind: ProfileKind,
  phase: "start" | "stop"
) =>
  Effect.tryPromise({
    catch: () =>
      failure(
        phase === "start"
          ? `Could not start the ${kind === "cpu" ? "CPU profile" : "performance trace"}. Stop the one already running first.`
          : `No ${kind === "cpu" ? "CPU profile" : "performance trace"} is running on this tab. Start one first.`
      ),
    try: async (): Promise<string> => {
      if (kind === "cpu") {
        if (phase === "start") {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.start");
          return "";
        }
        const { profile } = await cdp.send("Profiler.stop");
        await cdp.send("Profiler.disable");
        return JSON.stringify(profile);
      }
      if (phase === "start") {
        await cdp.send("Tracing.start", {
          traceConfig: { includedCategories: TRACE_CATEGORIES },
          transferMode: "ReturnAsStream",
        });
        return "";
      }
      const complete = tracingComplete(cdp);
      await cdp.send("Tracing.end");
      const handle = await complete;
      if (handle === undefined) {
        throw new Error("Trace returned no stream");
      }
      return await readStream(cdp, handle);
    },
  });
