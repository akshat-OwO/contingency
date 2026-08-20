import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Flow, Run } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";

import { AgentBrowserLive } from "../../src/services/agent-browser";
import type {
  RunnerRunOptions,
  RunnerService,
} from "../../src/services/runner";
import { Runner, RunnerLive } from "../../src/services/runner";

/**
 * The real Runner, driving the real bundled browser.
 *
 * Tests here run with `it.live`. A real browser runs on the real clock, and a
 * Runner that waits for anything — a navigation, a metric — waits forever
 * against a test clock.
 *
 * Everything else in this suite substitutes the browser, which is why it can
 * never falsify the risks that actually bite: whether a Flow's selectors
 * resolve against real DOM, and whether the browser's own commands answer in a
 * shape we can read. Here nothing is stubbed.
 */
export const IntegrationLive = RunnerLive.pipe(
  Layer.provide(AgentBrowserLive),
  Layer.provideMerge(NodeServices.layer)
);

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "fixtures");

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
        const page = pages.get(new URL(url, "http://fixtures").pathname);
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
        // Waiting for the close to finish, so a finished test leaves no
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
  { readonly persisted: Run; readonly run: Run },
  unknown,
  RunnerService | FileSystem.FileSystem
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

    return { persisted, run };
  }).pipe(Effect.scoped);
