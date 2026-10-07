import type {
  BrowserDiagnostics,
  BrowserRpcErrorType,
  SessionId,
} from "@contingency/protocol";
import { Effect, Scope } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import type { ConsoleMessage } from "playwright-core";

import { redactKnownValues } from "./agent-browser.ts";
import type {
  BrowserTarget,
  CreateBrowserService,
} from "./create-browser-contract.ts";

export type BrowserDiagnosticsReader = (
  browser: CreateBrowserService,
  sessionId: SessionId,
  privateValues: readonly string[]
) => Effect.Effect<BrowserDiagnostics, BrowserRpcErrorType>;

/** Console contents and all stored values stay private. No raw request headers or payloads escape. */
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
          { level: message.type(), text: "[content withheld]" as const },
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
      privateValues: readonly string[]
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
          const names =
            snapshot.kind === "cookies"
              ? snapshot.cookies.map((cookie) => cookie.name)
              : Object.keys(snapshot.entries);
          truncated ||= names.length > 50;
          storage.push(
            ...names.slice(0, 50).map((name) => ({
              kind: kind === "cookies" ? ("cookie" as const) : kind,
              name: redactKnownValues(name, privateValues).slice(0, 256),
              value: "[value withheld]" as const,
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
              path: redactKnownValues(url.pathname, privateValues).slice(
                0,
                256
              ),
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
