import { randomUUID } from "node:crypto";

import { makeBrowserRpcError } from "@contingency/protocol";
import { Effect } from "effect";
import type { CDPSession } from "playwright-core";

import { boundedDevtoolsText } from "./browser-devtools.ts";
import { domainScopeCovers, webHost } from "./domain-scope.ts";

export interface BrowserEvaluationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly failed: boolean;
}

/** Each evaluation has its own realm. Its asynchronous callbacks retain these
 * guards, while the application's realm and network APIs remain untouched. */
const networkGuards = (hosts: readonly string[]) => `(() => {
  if (globalThis.__contingencyEvaluationGuard) return;
  const hosts = ${JSON.stringify(hosts)};
  const URLConstructor = URL;
  const RequestConstructor = Request;
  const apply = Reflect.apply;
  const construct = Reflect.construct;
  const base = location.href;
  const string = String;
  const lower = String.prototype.toLowerCase;
  const suffix = String.prototype.endsWith;
  const slice = String.prototype.slice;
  const hostOf = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname').get;
  const protocolOf = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get;
  const hrefOf = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get;
  const requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url').get;
  const check = value => {
    const url = new URLConstructor(string(value), base);
    const host = apply(lower, apply(hostOf, url, []), []);
    const protocol = apply(protocolOf, url, []);
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'ws:' || protocol === 'wss:') {
      for (let index = 0; index < hosts.length; index++) {
        const entry = hosts[index];
        if (entry === host || (entry[0] === '*' && entry[1] === '.' &&
            apply(suffix, host, [apply(slice, entry, [1])]) && host.length > entry.length - 1)) {
          return apply(hrefOf, url, []);
        }
      }
    }
    throw new Error('Evaluation request blocked: host is outside the Domain Scope.');
  };
  const lock = (target, key, value) => Object.defineProperty(target, key,
    { value, configurable: false, writable: false });
  lock(globalThis, '__contingencyEvaluationGuard', true);
  const originalFetch = fetch;
  lock(globalThis, 'fetch', function(input, init) {
    const request = new RequestConstructor(input, { ...init, redirect: 'error' });
    check(apply(requestUrl, request, []));
    return apply(originalFetch, this, [request]);
  });
  const open = XMLHttpRequest.prototype.open;
  lock(XMLHttpRequest.prototype, 'open', function(method, url, ...rest) {
    return apply(open, this, [method, check(url), ...rest]);
  });
  const beacon = navigator.sendBeacon;
  lock(Navigator.prototype, 'sendBeacon', function(url, data) {
    return apply(beacon, this, [check(url), data]);
  });
  const websocket = WebSocket;
  const guardedWebSocket = new Proxy(websocket, {
    construct(target, args) { args[0] = check(args[0]); return construct(target, args); }
  });
  lock(websocket.prototype, 'constructor', guardedWebSocket);
  lock(globalThis, 'WebSocket', guardedWebSocket);
})()`;

interface InitiatorStack {
  readonly callFrames: readonly { readonly url: string }[];
  readonly parent?: InitiatorStack;
  readonly parentId?: { readonly id: string; readonly debuggerId?: string };
}

/** Fetch interception follows redirects too. Async stack tracking attributes
 * promise/timer requests without restricting the application's own traffic. */
const networkPolicies = new WeakMap<
  CDPSession,
  Promise<Map<string, readonly string[]>>
>();
const evaluationScripts = new WeakMap<CDPSession, Set<string>>();
const requireNetworkPolicy = (cdp: CDPSession) => {
  const existing = networkPolicies.get(cdp);
  if (existing !== undefined) {
    return existing;
  }
  const initialized = (async () => {
    const policies = new Map<string, readonly string[]>();
    const scripts = new Set<string>();
    evaluationScripts.set(cdp, scripts);
    const requests = new Map<string, Promise<readonly string[] | undefined>>();
    const policyFor = async (
      stack?: InitiatorStack
    ): Promise<readonly string[] | undefined> => {
      if (stack === undefined) {
        return undefined;
      }
      for (const frame of stack.callFrames) {
        const policy = policies.get(frame.url);
        if (policy !== undefined) {
          return policy;
        }
      }
      if (stack.parent !== undefined) {
        return await policyFor(stack.parent);
      }
      if (stack.parentId !== undefined) {
        const { stackTrace } = await cdp.send("Debugger.getStackTrace", {
          stackTraceId: stack.parentId,
        });
        return await policyFor(stackTrace);
      }
      return undefined;
    };
    cdp.on("Network.requestWillBeSent", (event) => {
      if (
        !requests.has(event.requestId) ||
        event.redirectResponse === undefined
      ) {
        requests.set(event.requestId, policyFor(event.initiator.stack));
      }
    });
    cdp.on("Fetch.requestPaused", (event) => {
      void (async () => {
        try {
          const policy =
            event.networkId === undefined
              ? undefined
              : await requests.get(event.networkId);
          const host = webHost(event.request.url);
          await (policy !== undefined &&
          (host === undefined ||
            !policy.some((entry) => domainScopeCovers(entry, host)))
            ? cdp.send("Fetch.failRequest", {
                errorReason: "BlockedByClient",
                requestId: event.requestId,
              })
            : cdp.send("Fetch.continueRequest", {
                requestId: event.requestId,
              }));
        } catch {
          // Closing the owning browser detaches CDP and cancels paused requests.
        }
      })();
    });
    const finish = ({ requestId }: { readonly requestId: string }) => {
      requests.delete(requestId);
    };
    cdp.on("Network.loadingFinished", finish);
    cdp.on("Network.loadingFailed", finish);
    cdp.on("Runtime.executionContextsCleared", () => {
      policies.clear();
      // In-flight requests retain their policy through unload and redirects.
      // loadingFinished/loadingFailed release them, even after their realm ends.
      const retired = [...scripts];
      scripts.clear();
      void (async () => {
        try {
          await Promise.all(
            retired.map((identifier) =>
              cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
                identifier,
              })
            )
          );
        } catch {
          // Browser closure also releases all document scripts.
        }
      })();
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Debugger.enable");
    // Async stack ids need the debugger; the page's own breakpoints must not pause.
    await cdp.send("Debugger.setSkipAllPauses", { skip: true });
    await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
    await cdp.send("Fetch.enable", {
      patterns: [{ requestStage: "Request", urlPattern: "*" }],
    });
    return policies;
  })();
  networkPolicies.set(cdp, initialized);
  return initialized;
};

/** The Runtime.evaluate response fields read here; playwright-core does not
 * export its Protocol namespace. */
interface EvaluateResponse {
  readonly result: {
    readonly value?: unknown;
    readonly unserializableValue?: string;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text: string;
    readonly exception?: { readonly description?: string };
  };
}
const evaluationResult = (
  result: EvaluateResponse,
  mode: "read_only" | "mutating",
  secrets: readonly string[]
): BrowserEvaluationResult => {
  const exception = result.exceptionDetails;
  const message = exception?.exception?.description ?? exception?.text;
  if (mode === "read_only" && message?.includes("side-effect")) {
    return {
      failed: true,
      text: "Read-only evaluation aborted on a side effect. Request mutating evaluation for this script; it requires Confirmation for each attempt in an Interactive Run.",
      truncated: false,
    };
  }
  const text =
    message ??
    (result.result.value === undefined
      ? (result.result.unserializableValue ??
        result.result.description ??
        "undefined")
      : JSON.stringify(result.result.value));
  // Bound after scrubbing so a clipped secret can never escape redaction.
  return {
    ...boundedDevtoolsText(text, secrets),
    failed: exception !== undefined,
  };
};

/** CDP supplies the side-effect check; no source-code heuristic decides whether
 * a script is read-only. Only fixed protocol operations are exposed to callers. */
export const evaluateBrowserScript = (
  cdp: CDPSession,
  script: string,
  mode: "read_only" | "mutating",
  hosts: readonly string[],
  secrets: readonly string[]
) =>
  Effect.tryPromise({
    catch: () =>
      makeBrowserRpcError(
        "agent_browser_failed",
        "Evaluation failed or timed out. A mutating attempt may already have changed the page; inspect it before requesting fresh Confirmation."
      ),
    try: async (): Promise<BrowserEvaluationResult> => {
      if (mode === "read_only") {
        // throwOnSideEffect already refuses network APIs, so read-only scripts
        // run in the page's own realm without guards or a realm budget.
        return evaluationResult(
          await cdp.send("Runtime.evaluate", {
            awaitPromise: true,
            disableBreaks: true,
            expression: script,
            returnByValue: true,
            silent: true,
            throwOnSideEffect: true,
            timeout: 10_000,
          }),
          mode,
          secrets
        );
      }
      const policies = await requireNetworkPolicy(cdp);
      if (policies.size >= 256) {
        throw new Error(
          "Reload the page before creating more evaluation realms."
        );
      }
      const source = `contingency-eval-${randomUUID()}`;
      policies.set(source, hosts);
      // Install in every frame of this isolated world, including frames that
      // callbacks create later. A foreign frame must not expose an unguarded
      // WebSocket constructor through contentWindow.
      const { identifier } = await cdp.send(
        "Page.addScriptToEvaluateOnNewDocument",
        {
          runImmediately: true,
          source: networkGuards(hosts),
          worldName: source,
        }
      );
      evaluationScripts.get(cdp)?.add(identifier);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const { executionContextId } = await cdp.send(
        "Page.createIsolatedWorld",
        {
          frameId: frameTree.frame.id,
          worldName: source,
        }
      );
      const guarded = await cdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: networkGuards(hosts),
      });
      if (guarded.exceptionDetails !== undefined) {
        throw new Error("Could not install evaluation network guards.");
      }
      return evaluationResult(
        await cdp.send("Runtime.evaluate", {
          awaitPromise: true,
          contextId: executionContextId,
          disableBreaks: true,
          expression: `${script}\n//# sourceURL=${source}`,
          returnByValue: true,
          silent: true,
          timeout: 10_000,
        }),
        mode,
        secrets
      );
    },
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.tryPromise(() => cdp.send("Runtime.terminateExecution")).pipe(
        Effect.ignore
      )
    ),
    Effect.interruptible,
    Effect.timeout("15 seconds"),
    Effect.mapError(() =>
      makeBrowserRpcError(
        "agent_browser_failed",
        "Evaluation failed or timed out. Inspect the page before requesting fresh Confirmation for another mutating attempt."
      )
    )
  );
