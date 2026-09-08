import { randomUUID } from "node:crypto";

import { Effect, Layer, Option, Schema } from "effect";
import type { Frame, Page } from "playwright-core";

import { CreateBrowser } from "./create-browser-contract.ts";
import {
  connectionLost,
  decodeNavigationEvent,
  integrityLost,
  makeEventRateLimit,
  makeOrderedRecorderEventHandler,
  readRecorderPayload,
  recorderError,
  refusalFailure,
} from "./recorder-events.ts";
import type {
  CaptureFailure,
  RecorderCaptureEvent,
  RecorderSequences,
} from "./recorder-events.ts";
import {
  recorderCleanupExpression,
  recorderScriptSource,
  recorderSetSwallowClicksExpression,
} from "./recorder-script.ts";
import { makeRecordingService, Recording } from "./recording.ts";
import type {
  RecorderCapture,
  RecorderCaptureStartOptions,
} from "./recording.ts";

/** Teardown that must not turn a closed browser into a defect. */
const tryQuietly = <Success>(run: () => Promise<Success>) =>
  Effect.tryPromise({ catch: () => null, try: run }).pipe(Effect.ignore);

const RecorderBindingArguments = Schema.Tuple([Schema.String, Schema.String]);

const CONNECTION_LOST = connectionLost(
  "The browser recorder connection was lost."
);
const SESSION_UNREACHABLE = "The recorder could not reach the browser session.";
const SESSION_CLOSED = integrityLost("The pinned browser session was closed.");
const PAGE_CLOSED = integrityLost("The pinned Page was closed.");
const EVENT_LIMIT = integrityLost(
  "The page exceeded the recorder event limit."
);

/**
 * Capture through Playwright.
 *
 * The recorder is installed with `addInitScript` on the pinned context and
 * reports through an exposed binding, so every frame — cross-origin ones
 * included — is reached by the same two calls that reach the main one, and no
 * CDP session is opened for recording at all ([ADR
 * 0012](../../../../docs/adr/0012-playwright-is-the-in-process-browser-runtime.md)).
 *
 * A popup or new tab is a further Page rather than the end of the Recording
 * ([ADR 0019](../../../../docs/adr/0019-recording-follows-pages.md)): Pages
 * are numbered in the order they opened, and each captured Step names the one
 * it happened on. What stays terminal is what it always was — lost integrity:
 * malformed data, an interrupted sequence, an event flood, an element no
 * locator can address, a navigation while paused, and the pinned session
 * closing under the Recording.
 */
export const makePlaywrightRecorderCapture = Effect.gen(
  function* makePlaywrightRecorderCapture() {
    const browser = yield* CreateBrowser;

    const start = Effect.fn("Recorder.start")(function* startCapture(
      options: RecorderCaptureStartOptions
    ) {
      // Recovery re-pins the Page the Recording already names, so Page 0 stays
      // Page 0 across a recovery: an index that moved would make Steps
      // recorded before and after name different Pages for the same tab.
      const target = yield* browser.recorderTarget(
        options.sessionId,
        options.tabId
      );
      // The Emulation the session is applying is what the Flow will declare,
      // so a headless Run reproduces the conditions authored against (ADR
      // 0013). Read at capture start, because emulation changes are locked
      // for the session while a Recording is in progress.
      const emulation = yield* browser.getEmulation(options.sessionId);
      const bindingName = `__contingency_${randomUUID().replaceAll("-", "")}`;
      const nonce = randomUUID();
      const scriptSource = recorderScriptSource(
        bindingName,
        nonce,
        randomUUID()
      );
      const cleanupExpression = recorderCleanupExpression(nonce);
      const sequences: RecorderSequences = new Map();
      const rateLimit = makeEventRateLimit();
      const ordered = makeOrderedRecorderEventHandler(
        options.onEvent,
        options.onFailure
      );

      let closing = false;
      const pages: Page[] = [
        target.page,
        ...target.context.pages().filter((page) => page !== target.page),
      ];
      // Every Page open before capture started is Page 0's peer, so only a
      // Page that opens later has an unrecorded first navigation to skip.
      const awaitingFirstNavigation = new WeakSet<Page>();

      const failCapture = (failure: CaptureFailure) => {
        if (closing) {
          return;
        }
        closing = true;
        Effect.runFork(options.onFailure(failure));
      };

      const pageIndex = (page: Page): number => {
        const known = pages.indexOf(page);
        if (known !== -1) {
          return known;
        }
        pages.push(page);
        return pages.length - 1;
      };

      const dispatch = (event: RecorderCaptureEvent) => {
        if (closing) {
          return;
        }
        if (rateLimit.exceeded()) {
          failCapture(EVENT_LIMIT);
          return;
        }
        ordered.dispatch(event);
      };

      const watchPage = (page: Page, pinned: boolean) => {
        if (pinned) {
          // A crashed Page is the recorder connection being lost: the Page
          // survives, so recovery re-pins this same Page and its index holds.
          page.on("crash", () => {
            failCapture(CONNECTION_LOST);
          });
          // A closed one cannot be re-pinned, and recovering onto a different
          // Page would renumber every Page the Recording already named.
          page.on("close", () => {
            failCapture(PAGE_CLOSED);
          });
        }
        page.on("framenavigated", (frame: Frame) => {
          if (closing || frame !== page.mainFrame()) {
            return;
          }
          if (awaitingFirstNavigation.has(page)) {
            awaitingFirstNavigation.delete(page);
            return;
          }
          const navigation = decodeNavigationEvent({ url: frame.url() });
          if (navigation !== undefined) {
            dispatch({ ...navigation, page: pageIndex(page) });
          }
        });
      };

      const binding = yield* Effect.tryPromise({
        catch: () => recorderError(SESSION_UNREACHABLE),
        try: () =>
          target.context.exposeBinding(
            bindingName,
            (source: { readonly page: Page }, ...args) => {
              if (closing) {
                return;
              }
              const decoded = Schema.decodeUnknownOption(
                RecorderBindingArguments
              )(args);
              if (Option.isNone(decoded)) {
                return;
              }
              const [presented, raw] = decoded.value;
              const outcome = readRecorderPayload(
                presented,
                raw,
                sequences,
                nonce
              );
              if (outcome._tag === "forged") {
                // Page code calling the binding it found. It reports nothing,
                // and it does not end the Recording: a site must not be able
                // to destroy an author's work by calling a function.
                return;
              }
              if (outcome._tag === "refused") {
                failCapture(refusalFailure(outcome.refusal));
                return;
              }
              dispatch({
                ...outcome.event,
                page: pageIndex(source.page),
              });
            }
          ),
      });

      const script = yield* Effect.tryPromise({
        catch: () => recorderError(SESSION_UNREACHABLE),
        try: () => target.context.addInitScript({ content: scriptSource }),
      }).pipe(Effect.tapError(() => tryQuietly(() => binding.dispose())));

      const onNewPage = (page: Page) => {
        if (closing) {
          return;
        }
        awaitingFirstNavigation.add(page);
        pageIndex(page);
        watchPage(page, false);
      };
      const onContextClosed = () => {
        failCapture(SESSION_CLOSED);
      };
      target.context.on("page", onNewPage);
      target.context.on("close", onContextClosed);
      for (const page of pages) {
        watchPage(page, page === target.page);
      }

      // Every frame already loaded predates the init script, so each is given
      // the recorder directly rather than on its next navigation — the frame
      // API reaching a cross-origin child exactly as it reaches the main one.
      yield* Effect.forEach(
        pages.flatMap((page) => page.frames()),
        (frame) => tryQuietly(() => frame.evaluate(scriptSource)),
        { discard: true }
      );

      return {
        emulation,
        setHoverPickerSwallowClicks: (swallow: boolean) =>
          Effect.forEach(
            pages.flatMap((page) => page.frames()),
            (frame) =>
              tryQuietly(() =>
                frame.evaluate(
                  recorderSetSwallowClicksExpression(nonce, swallow)
                )
              ),
            { discard: true }
          ),
        stop: Effect.gen(function* stopCapture() {
          closing = true;
          target.context.off("page", onNewPage);
          target.context.off("close", onContextClosed);
          yield* ordered.close();
          // A Page that has already closed cannot be cleaned up, and does not
          // need to be: every teardown below is best-effort, because stopping
          // is also what a lost session does.
          yield* Effect.forEach(
            pages.flatMap((page) => page.frames()),
            (frame) => tryQuietly(() => frame.evaluate(cleanupExpression)),
            { discard: true }
          );
          yield* tryQuietly(() => script.dispose());
          yield* tryQuietly(() => binding.dispose());
        }),
        tabId: target.tabId,
        url: target.page.url(),
      };
    });

    return { start } satisfies RecorderCapture;
  }
);

export const RecordingLive = Layer.effect(
  Recording,
  makePlaywrightRecorderCapture.pipe(Effect.flatMap(makeRecordingService))
);
