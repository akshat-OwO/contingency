import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Flow, Run } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import type { Scope } from "effect/Scope";

import type {
  RunnerRunOptions,
  RunnerService,
} from "../../src/services/runner.ts";
import { Runner, RunnerLive } from "../../src/services/runner.ts";

/**
 * The real Runner, driving a real Chromium in process.
 *
 * Tests here run with `it.live`. A real browser runs on the real clock, and a
 * Runner that waits for anything — a navigation, a metric — waits forever
 * against a test clock.
 *
 * Nothing here is stubbed. Every other suite substitutes the browser or its
 * inputs, and so can never falsify the risks that actually bite: whether a
 * Flow's locators resolve against real DOM, and whether the browser answers
 * in a shape the Runner can read.
 */
export const IntegrationLive = RunnerLive.pipe(
  Layer.provideMerge(NodeServices.layer)
);

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "fixtures");

const ffprobe = promisify(execFile);

/**
 * Whether recordings on this machine can be decoded. Asserting what a WebM
 * contains needs `ffprobe`; tests that decode skip where it is missing,
 * because the absence is the environment's, not the code's.
 */
export const canDecodeVideo = (): boolean =>
  (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .some((directory) => existsSync(path.join(directory, "ffprobe")));

/** How many seconds ffprobe reports for a recording. */
export const recordingDurationSeconds = (
  file: string
): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`ffprobe failed: ${String(cause)}`),
    try: async () => {
      const probed = await ffprobe("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        file,
      ]);
      return Number(String(probed.stdout).trim());
    },
  });

/** How many decoded video frames ffprobe reads from an artifact. */
export const recordingFrameCount = (
  file: string
): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`ffprobe failed: ${String(cause)}`),
    try: async () => {
      const probed = await ffprobe("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        file,
      ]);
      return Number(String(probed.stdout).trim());
    },
  });

/**
 * What the fixture page requests once a Step has typed into it. Waiting for
 * this proves the Run is past its opening navigation and working through
 * Steps, which request arrival and an empty recording file do not.
 */
export const STEP_BEACON = "/step-beacon";

/** What the lazy fixture requests once its below-the-fold content loads. */
export const LAZY_LOADED_BEACON = "/lazy-loaded-beacon";

/** What the shop fixture requests once its cart is viewed. */
export const CART_VIEWED_BEACON = "/cart-viewed";

/** What the busy fixture requests on every tick after load, forever. */
export const BUSY_TICK_BEACON = "/busy-tick-beacon";

/** What the late fixture requests once its content has finished arriving. */
export const LATE_CONTENT_BEACON = "/settled-beacon";

/** A response held briefly so navigation can prove it waits for network idle. */
export const LOAD_READY_BEACON = "/load-ready-beacon";

/**
 * What the stateful fixture requests at load, carrying the cart count it read
 * from origin storage: `?at-load=0` means this Run started fresh.
 */
export const CART_STATE_BEACON = "/cart-beacon";

/** A path the fixture server accepts and never responds to. */
export const NEVER_ANSWERED = "/never-answered.bin";

const NOT_FOUND = 404;
const OK = 200;

/**
 * Serve the fixture pages for the duration of a test, on a port the operating
 * system picks so concurrent runs never collide.
 *
 * Real HTTP rather than `file://`: a Run is measured and audited as a page
 * served over the network, and `file://` differs in ways that matter — no
 * navigation timing worth reading, and a different origin model for frames.
 */
export const fixtureServer = Effect.gen(function* serveFixtures() {
  const fileSystem = yield* FileSystem.FileSystem;
  // Read up front, so serving a request is synchronous and a test never races
  // the disk. Fixtures are small and static; later tickets add files here.
  const names = yield* fileSystem.readDirectory(FIXTURE_DIRECTORY);
  const pages = new Map<string, string>();
  for (const name of names) {
    pages.set(
      `/${name}`,
      yield* fileSystem.readFileString(path.join(FIXTURE_DIRECTORY, name))
    );
  }

  /**
   * Every path the browser asked for, in order. What the page received is the
   * only evidence that a fill reached the field it named rather than merely
   * that a selector resolved to something.
   */
  const requests: string[] = [];

  const server = yield* Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const created = createServer((request, response) => {
        const url = request.url ?? "/";
        requests.push(url);
        const { pathname } = new URL(url, "http://fixtures");
        // Answered by nothing at all, so a Run that asks for it waits: the
        // only way to test what an interrupted Run leaves behind is to have
        // one still running when the signal arrives.
        if (pathname === NEVER_ANSWERED) {
          return;
        }
        if (pathname === LOAD_READY_BEACON) {
          setTimeout(() => {
            response
              .writeHead(OK, { "content-type": "text/plain; charset=utf-8" })
              .end("ready");
          }, 250);
          return;
        }
        const page = pages.get(pathname);
        if (page === undefined) {
          response.writeHead(NOT_FOUND).end();
          return;
        }
        response
          .writeHead(OK, { "content-type": "text/html; charset=utf-8" })
          .end(page);
      });
      // Port zero: the operating system picks one, so concurrent runs of this
      // suite never collide on a fixed port.
      created.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(created));
      });
    }),
    (created) =>
      // `null` rather than nothing: the formatter rewrites an explicit
      // `undefined` here into a zero-argument call that does not typecheck.
      Effect.callback<null>((resume) => {
        // Sockets first: `close` waits for open requests to finish, and this
        // server answers one of them deliberately never. Without this a test
        // that leaves that request in flight hangs teardown until the suite
        // times out, which is a confusing way to report any failure.
        created.closeAllConnections();
        // Then wait for the close itself, so a finished test leaves no
        // listening socket behind for the next one to trip over.
        created.close(() => {
          resume(Effect.succeed(null));
        });
      })
  );

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    /** The URL of a fixture page, for a Flow to navigate to. */
    url: (page: string) => `${origin}/${page}`,
  };
});

/** A Flow, with the boilerplate a Recorder would have written for it. */
export const flow = (steps: Flow["steps"], title = "Integration"): Flow =>
  ({ steps, title }) as Flow;

/**
 * Execute a Flow through the real Runner and hand back the Run, plus the
 * Run as it was actually written to disk — the two should agree, and a Run
 * that never persisted is not a Run.
 */
export const runFlow = (
  target: Flow,
  options?: Partial<RunnerRunOptions>
): Effect.Effect<
  { readonly directory: string; readonly persisted: Run; readonly run: Run },
  unknown,
  RunnerService | FileSystem.FileSystem | Scope
> =>
  Effect.gen(function* executeFlow() {
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* Runner;
    const outputDirectory = yield* fileSystem.makeTempDirectoryScoped({
      directory: tmpdir(),
      prefix: "contingency-integration-",
    });

    const { directory, run } = yield* runner.run(target, {
      outputDirectory,
      // One attempt: a retry would mask exactly the flakiness this suite is
      // here to expose.
      retry: 0,
      ...options,
    });

    const persisted = yield* fileSystem
      .readFileString(path.join(directory, "run.json"))
      .pipe(Effect.map((contents) => JSON.parse(contents) as Run));

    // The temporary output directory belongs to the caller's scope, not this
    // one: a test that reads the Run's artifacts has to outlive the Run.
    return { directory, persisted, run };
  });
