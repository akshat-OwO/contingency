import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DraftEmulation,
  UserAgentProfileId,
  Viewport,
} from "@contingency/protocol";
import { Effect, FileSystem } from "effect";

const isTcpAddress = (
  address: AddressInfo | string | null
): address is AddressInfo => address !== null && typeof address !== "string";

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
 * How many of an artifact's frames can be seeked to directly. A slideshow is
 * seeked to rather than played through, so this should equal its frame count.
 */
export const keyframeCount = (file: string): Effect.Effect<number, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`ffprobe failed: ${String(cause)}`),
    try: async () => {
      const probed = await ffprobe("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=flags",
        "-of",
        "csv=p=0",
        file,
      ]);
      return String(probed.stdout)
        .split("\n")
        .filter((flags) => flags.startsWith("K")).length;
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

/** A Scroll-started response held long enough to exercise readiness waiting. */
export const SCROLL_READY_BEACON = "/scroll-ready-beacon";

/** What the nested Scroll fixture requests when its container moves. */
export const NESTED_SCROLL_BEACON = "/nested-scroll-beacon";

/** What the nested Scroll fixture requests when the document moves. */
export const DOCUMENT_SCROLL_BEACON = "/document-scroll-beacon";

/** What the Takeover fixture requests for every input the user sends it. */
export const USER_INPUT_BEACON = "/user-input-beacon";

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

  /**
   * The headers of every request, in the same order. The first document
   * request is the only place a browser identity can be proved to have been
   * installed *before* the page existed rather than patched afterwards.
   */
  const requestHeaders: { headers: Record<string, string>; url: string }[] = [];

  const server = yield* Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const created = createServer((request, response) => {
        const url = request.url ?? "/";
        requests.push(url);
        requestHeaders.push({
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(", ") : (value ?? ""),
            ])
          ),
          url,
        });
        const { pathname } = new URL(url, "http://fixtures");
        if (pathname === "/boundary-redirect-chain") {
          response.writeHead(302, { location: "/boundary-redirect" }).end();
          return;
        }
        if (pathname === "/boundary-approved-redirect") {
          response.writeHead(302, { location: "/agent-boundary.html" }).end();
          return;
        }
        // Answered by nothing at all, so a Run that asks for it waits: the
        // only way to test what an interrupted Run leaves behind is to have
        // one still running when the signal arrives.
        if (pathname === "/boundary-redirect") {
          const address = created.address();
          response
            .writeHead(302, {
              location: `http://localhost:${String(isTcpAddress(address) ? address.port : 0)}/outside-boundary`,
            })
            .end();
          return;
        }
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
        if (pathname === SCROLL_READY_BEACON) {
          // Answered on the next tick rather than after a long sleep. The
          // Scroll readiness wait is bounded at two seconds by the Runner, and
          // a test cannot raise that bound; every millisecond spent here is a
          // millisecond a loaded CI runner cannot spend on the scroll
          // animation and the quiet window that follow. The request is still
          // in flight when readiness begins observing, which is what the
          // "adopts finite Scroll-started work" test needs it to be.
          setImmediate(() => {
            response
              .writeHead(OK, { "content-type": "text/plain; charset=utf-8" })
              .end("ready");
          });
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

  const address = server.address();
  if (!isTcpAddress(address)) {
    throw new Error("Fixture server did not bind to a TCP address.");
  }
  const { port } = address;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requestHeaders,
    requests,
    /** The URL of a fixture page, for a Flow to navigate to. */
    url: (page: string) => `${origin}/${page}`,
  };
});

/**
 * One Emulation snapshot for `CreateBrowser.open`, which takes the identity,
 * viewport, and environment as a single value rather than separate arguments.
 */
export const draftEmulation = (
  userAgentProfile: UserAgentProfileId,
  viewport: Viewport,
  environment: Partial<
    Omit<DraftEmulation, "userAgentProfile" | "viewport">
  > = {}
): DraftEmulation => ({
  ...environment,
  permissions: environment.permissions ?? [],
  userAgentProfile,
  viewport,
});
