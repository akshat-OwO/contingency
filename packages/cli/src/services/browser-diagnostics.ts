import type {
  BrowserDiagnostics,
  BrowserRpcErrorType,
  SessionId,
} from "@contingency/protocol";
import { Effect, Scope } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ConsoleMessage } from "playwright-core";

import type {
  BrowserTarget,
  CreateBrowserService,
} from "./create-browser-contract.ts";

export type BrowserDiagnosticsReader = (
  browser: CreateBrowserService,
  sessionId: SessionId,
  _privateValues: readonly string[]
) => Effect.Effect<BrowserDiagnostics, BrowserRpcErrorType>;

/** Read bounded browser diagnostics with journey values intact. */
export const makeBrowserDiagnostics = (
  target: BrowserTarget,
  scope: Scope.Scope
) =>
  Effect.gen(function* installDiagnostics() {
    const registry = AtomRegistry.make();
    const consoleEntries = Atom.make<BrowserDiagnostics["console"]>([]).pipe(
      Atom.keepAlive
    );
    let consoleTruncated = false;
    const onConsole = (message: ConsoleMessage) => {
      const entries = registry.get(consoleEntries);
      consoleTruncated ||= entries.length >= 50;
      registry.set(
        consoleEntries,
        [
          ...entries,
          { level: message.type(), text: message.text().slice(0, 8192) },
        ].slice(-50)
      );
    };
    target.context.on("console", onConsole);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        target.context.off("console", onConsole);
        registry.dispose();
      })
    );
    return (
      browser: CreateBrowserService,
      sessionId: SessionId,
      _privateValues: readonly string[]
    ) =>
      Effect.gen(function* readDiagnostics() {
        const active = yield* browser.activeTarget(sessionId);
        const requests = yield* browser.getNetworkRequests(
          sessionId,
          active.tabId
        );
        const storage: BrowserDiagnostics["storage"][number][] = [];
        let truncated = consoleTruncated || requests.length > 50;
        for (const kind of ["cookies", "local", "session"] as const) {
          const snapshot = yield* browser.getStorage(
            sessionId,
            active.tabId,
            kind
          );
          const entries =
            snapshot.kind === "cookies"
              ? snapshot.cookies.map(
                  (cookie) => [cookie.name, cookie.value] as const
                )
              : Object.entries(snapshot.entries);
          truncated ||= entries.length > 50;
          storage.push(
            ...entries.slice(0, 50).map(([name, value]) => ({
              kind: kind === "cookies" ? ("cookie" as const) : kind,
              name: name.slice(0, 256),
              value: value.slice(0, 8192),
            }))
          );
        }
        const network: BrowserDiagnostics["network"][number][] = [];
        for (const request of requests.slice(-50)) {
          try {
            const url = new URL(request.url);
            network.push({
              method: request.method,
              origin: url.origin,
              path: url.pathname.slice(0, 256),
              status: request.status ?? null,
            });
          } catch {
            truncated = true;
          }
        }
        return {
          console: registry.get(consoleEntries),
          network,
          storage,
          truncated,
        };
      });
  });
