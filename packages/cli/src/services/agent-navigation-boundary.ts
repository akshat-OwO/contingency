import { makeBrowserRpcError } from "@contingency/protocol";
import { Deferred, Effect, Exit, Schema, Scope } from "effect";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";

interface NavigationPolicy {
  readonly allows: (url: string) => boolean;
  readonly refuse: (url: string) => Effect.Effect<void, unknown>;
}
interface Target {
  readonly contextId: string;
  readonly sessionId: string;
  readonly targetId: string;
}
const Message = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
});
const PausedRequest = Schema.Struct({
  request: Schema.Struct({ url: Schema.String }),
  requestId: Schema.String,
});
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new Error(String(cause)),
    try: run,
  });

/** One coordinator per Runner browser keeps interceptors bound to their session contexts. */
export class NavigationCoordinator {
  readonly policies = new Map<string, NavigationPolicy>();
  readonly targets = new Map<string, Deferred.Deferred<Target, Error>>();
  readonly sessions = new Map<string, Target>();
  readonly commands = new Map<
    number,
    {
      readonly done: Deferred.Deferred<null, Error>;
      readonly sessionId: string;
    }
  >();
  readonly root: CDPSession;
  readonly scope: Scope.Closeable;
  private sequence = 0;

  constructor(root: CDPSession, scope: Scope.Closeable) {
    this.root = root;
    this.scope = scope;
    root.on("Target.receivedMessageFromTarget", ({ message, sessionId }) => {
      this.run(this.handleMessage(sessionId, message));
    });
    root.on("Target.detachedFromTarget", ({ sessionId }) => {
      const target = this.sessions.get(sessionId);
      if (target !== undefined) {
        this.sessions.delete(sessionId);
        this.targets.delete(target.targetId);
      }
      for (const command of this.commands.values()) {
        if (command.sessionId === sessionId) {
          Effect.runSync(
            Deferred.fail(command.done, new Error("Navigation target closed"))
          );
        }
      }
    });
  }

  handleMessage(sessionId: string, message: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* receiveMessage() {
      const raw: unknown = yield* Effect.try(() => JSON.parse(message));
      const decoded = yield* Schema.decodeUnknownEffect(Message)(raw);
      if (decoded.id !== undefined) {
        const pending = this.commands.get(decoded.id);
        if (pending !== undefined && pending.sessionId === sessionId) {
          yield* decoded.error === undefined
            ? Deferred.succeed(pending.done, null)
            : Deferred.fail(
                pending.done,
                new Error(JSON.stringify(decoded.error))
              );
        }
        return;
      }
      if (decoded.method !== "Fetch.requestPaused") {
        return;
      }
      // Recover the request id before decoding the payload so malformed requests
      // can still be released with a refusal instead of hanging in Fetch.
      const { requestId } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ requestId: Schema.String })
      )(decoded.params);
      yield* Schema.decodeUnknownEffect(PausedRequest)(decoded.params).pipe(
        Effect.flatMap((paused) => this.handleRequest(sessionId, paused)),
        Effect.catchCause(() =>
          this.send(sessionId, "Fetch.failRequest", {
            errorReason: "BlockedByClient",
            requestId,
          }).pipe(Effect.ignore)
        )
      );
    }).pipe(Effect.catchCause(() => Effect.void));
  }

  run(effect: Effect.Effect<unknown>): void {
    Effect.runFork(Effect.forkIn(effect, this.scope));
  }

  send(
    sessionId: string,
    method: string,
    params: object
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* sendCommand() {
      this.sequence += 1;
      const id = this.sequence;
      const done = Deferred.makeUnsafe<null, Error>();
      this.commands.set(id, { done, sessionId });
      return yield* attempt(() =>
        this.root.send("Target.sendMessageToTarget", {
          message: JSON.stringify({ id, method, params }),
          sessionId,
        })
      ).pipe(
        Effect.andThen(Deferred.await(done)),
        Effect.asVoid,
        Effect.ensuring(Effect.sync(() => this.commands.delete(id)))
      );
    });
  }

  attach(targetId: string, contextId: string): Effect.Effect<Target, Error> {
    return Effect.gen({ self: this }, function* attachTarget() {
      const existing = this.targets.get(targetId);
      if (existing !== undefined) {
        return yield* Deferred.await(existing);
      }
      const ready = Deferred.makeUnsafe<Target, Error>();
      // Manual attachment also emits attachedToTarget; register before sending.
      this.targets.set(targetId, ready);
      const attach = Effect.gen({ self: this }, function* configureTarget() {
        const { sessionId } = yield* attempt(() =>
          this.root.send("Target.attachToTarget", { flatten: false, targetId })
        );
        const target = { contextId, sessionId, targetId };
        this.sessions.set(sessionId, target);
        if (this.policies.has(contextId)) {
          yield* this.enable(target);
        }
        return target;
      });
      const result = yield* Effect.exit(attach);
      yield* Deferred.done(ready, result);
      return yield* Deferred.await(ready);
    });
  }

  prepareContext(contextId: string): Effect.Effect<void, Error> {
    return attempt(() => this.root.send("Target.getTargets")).pipe(
      Effect.flatMap(({ targetInfos }) =>
        Effect.forEach(
          targetInfos.filter(
            (target) =>
              target.browserContextId === contextId &&
              (target.type === "page" || target.type === "iframe")
          ),
          (target) => this.attach(target.targetId, contextId),
          { concurrency: "unbounded", discard: true }
        )
      )
    );
  }

  enable(target: Target): Effect.Effect<void, Error> {
    return this.send(target.sessionId, "Fetch.enable", {
      patterns: [
        { requestStage: "Request", resourceType: "Document", urlPattern: "*" },
      ],
    });
  }

  handleRequest(
    sessionId: string,
    paused: typeof PausedRequest.Type
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* checkNavigationRequest() {
      const target = this.sessions.get(sessionId);
      const policy =
        target === undefined ? undefined : this.policies.get(target.contextId);
      if (policy !== undefined && !policy.allows(paused.request.url)) {
        yield* policy.refuse(paused.request.url);
        yield* this.send(sessionId, "Fetch.failRequest", {
          errorReason: "BlockedByClient",
          requestId: paused.requestId,
        });
        return;
      }
      yield* this.send(sessionId, "Fetch.continueRequest", {
        requestId: paused.requestId,
      });
    });
  }
}

const coordinators = new WeakMap<
  Browser,
  Deferred.Deferred<NavigationCoordinator, Error>
>();
const coordinatorFor = (browser: Browser) =>
  Effect.uninterruptible(
    Effect.gen(function* acquireCoordinator() {
      const existing = coordinators.get(browser);
      if (existing !== undefined) {
        return yield* Deferred.await(existing);
      }
      const ready = Deferred.makeUnsafe<NavigationCoordinator, Error>();
      coordinators.set(browser, ready);
      const result = yield* Effect.exit(
        Effect.gen(function* openCoordinator() {
          const root = yield* attempt(() => browser.newBrowserCDPSession());
          const scope = yield* Scope.make();
          const coordinator = new NavigationCoordinator(root, scope);
          browser.once("disconnected", () => {
            coordinators.delete(browser);
            Effect.runFork(Scope.close(scope, Exit.void));
          });
          return coordinator;
        })
      );
      yield* Deferred.done(ready, result);
      return yield* Deferred.await(ready);
    })
  );

/** Pauses every document request, including redirects and a popup's first request. */
export const installAgentNavigationBoundary = (
  context: BrowserContext,
  page: Page,
  policy: NavigationPolicy
) =>
  Effect.gen(function* installNavigationBoundary() {
    const browser = context.browser();
    if (browser === null) {
      return yield* Effect.fail(new Error("The Agent Session has no browser"));
    }
    const coordinator = yield* coordinatorFor(browser);
    const info = yield* Effect.acquireUseRelease(
      attempt(() => context.newCDPSession(page)),
      (probe) => attempt(() => probe.send("Target.getTargetInfo")),
      (probe) => attempt(() => probe.detach()).pipe(Effect.ignore)
    );
    const { browserContextId: contextId, targetId } = info.targetInfo;
    if (contextId === undefined) {
      return yield* Effect.fail(
        new Error("The Agent Session has no context id")
      );
    }
    coordinator.policies.set(contextId, policy);
    // Enforcement lasts through finalization, until the context actually closes.
    context.once("close", () => {
      coordinator.policies.delete(contextId);
    });
    const target = yield* coordinator.attach(targetId, contextId);
    yield* coordinator.enable(target);
    // Hold a popup's initial request until its CDP target is configured.
    // CDP checks subsequent redirects, which Playwright routes do not see.
    yield* attempt(() =>
      context.route("**/*", async (route) => {
        const request = route.request();
        const check = Effect.gen(function* checkInitialNavigation() {
          if (request.isNavigationRequest()) {
            if (!policy.allows(request.url())) {
              yield* policy.refuse(request.url());
              yield* attempt(() => route.abort("blockedbyclient"));
              return;
            }
            yield* coordinator.prepareContext(contextId);
          }
          yield* attempt(() => route.continue());
        }).pipe(
          Effect.catchCause(() =>
            attempt(() => route.abort("failed")).pipe(Effect.ignore)
          )
        );
        await Effect.runPromise(check);
      })
    );
  }).pipe(
    Effect.mapError((cause) =>
      makeBrowserRpcError(
        "agent_browser_failed",
        `Could not install the navigation boundary: ${String(cause)}`
      )
    )
  );
