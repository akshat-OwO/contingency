import { createHash, randomUUID } from "node:crypto";

import {
  AgentElementRef,
  AgentSnapshotId,
  makeBrowserRpcError,
} from "@contingency/protocol";
import type {
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { Effect } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type {
  AgentBrowser,
  AgentBrowserTab,
  AgentNavigationPolicy,
} from "../../src/services/agent-browser-contract.ts";

interface Control {
  readonly key: string;
  readonly name: string;
  readonly role: string;
  readonly sensitive?: boolean;
}
const controls: readonly Control[] = [
  { key: "message", name: "Message", role: "textbox" },
  { key: "password", name: "Password", role: "textbox", sensitive: true },
  { key: "save", name: "Save", role: "button" },
  { key: "remove", name: "Remove field", role: "button" },
];

const stale = (ref: string) =>
  makeBrowserRpcError(
    "agent_element_stale",
    `Element reference ${ref} is stale.`,
    "detached"
  );

/** A deliberately bounded site model. Unsupported behavior fails rather than pretending to succeed. */
export const makeInMemoryAgentBrowser = (input: {
  readonly url: string;
  readonly now?: () => Date;
  readonly onNavigate?: (url: string) => void;
}) =>
  Effect.gen(function* makeFakeAgentBrowser() {
    const atoms = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
    const state = Atom.make({
      epoch: 0,
      focused: "",
      removed: false,
      saved: false,
      url: input.url,
      values: new Map<string, string>(),
    }).pipe(Atom.keepAlive);
    const references = new Map<
      string,
      { readonly control: Control; readonly epoch: number }
    >();
    let policy: AgentNavigationPolicy | undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => policy?.dispose()));
    const now = input.now ?? (() => new Date());
    const refFor = (control: Control) =>
      AgentElementRef.make(
        `e${atoms.get(state).epoch * 10 + controls.indexOf(control) + 1}`
      );
    const resolve = (ref: string) =>
      Effect.suspend(() => {
        const entry = references.get(ref);
        const current = atoms.get(state);
        return entry === undefined ||
          entry.epoch !== current.epoch ||
          (current.removed && entry.control.key === "message")
          ? Effect.fail(stale(ref))
          : Effect.succeed(entry.control);
      });
    const snapshot = (): Effect.Effect<AgentBrowserSnapshot> =>
      Effect.sync(() => {
        const current = atoms.get(state);
        const nodes: AgentSnapshotNode[] = controls
          .filter((control) => !(current.removed && control.key === "message"))
          .map((control) => {
            const ref = refFor(control);
            references.set(ref, { control, epoch: current.epoch });
            const value = current.values.get(control.key);
            const node: AgentSnapshotNode = {
              depth: 0,
              interactive: true,
              name: control.name,
              ref,
              role: control.role,
            };
            if (value === undefined || value === "") {
              return node;
            }
            return control.sensitive
              ? { ...node, valueWithheld: true }
              : { ...node, value };
          });
        if (current.saved) {
          nodes.push({
            depth: 0,
            name: "Saved",
            ref: AgentElementRef.make(`e${current.epoch * 10 + 5}`),
            role: "status",
          });
        }
        return {
          capturedAt: now().toISOString(),
          coverage: {
            nextCursor: null,
            offset: 0,
            returned: nodes.length,
            selector: null,
            total: nodes.length,
            truncated: false,
          },
          nodes,
          settle: { pending: [], settled: true },
          snapshotId: AgentSnapshotId.make(randomUUID()),
          title: "Agent browser contract",
          url: current.url,
        };
      });
    const perform = (action: AgentBrowserAction) =>
      Effect.gen(function* performFakeAction() {
        if (action.type === "navigate") {
          if (policy !== undefined && !policy.allows(action.url)) {
            yield* policy.refuse(action.url).pipe(Effect.ignore);
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_browser_failed",
                "Navigation refused by Domain Scope."
              )
            );
          }
          atoms.update(state, (current) => ({
            ...current,
            epoch: current.epoch + 1,
            focused: "",
            removed: false,
            saved: false,
            url: action.url,
            values: new Map(),
          }));
          input.onNavigate?.(action.url);
          return;
        }
        if (action.type === "fill") {
          const control = yield* resolve(action.ref);
          if (control.role !== "textbox") {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_browser_failed",
                "This control cannot be filled."
              )
            );
          }
          atoms.update(state, (current) => ({
            ...current,
            focused: control.key,
            values: new Map(current.values).set(control.key, action.text),
          }));
          return;
        }
        if (action.type === "click") {
          const control = yield* resolve(action.ref);
          atoms.update(state, (current) => ({
            ...current,
            focused: control.key,
            removed: current.removed || control.key === "remove",
            saved: current.saved || control.key === "save",
          }));
          return;
        }
        return yield* Effect.fail(
          makeBrowserRpcError(
            "agent_browser_failed",
            `The in-memory site does not model ${action.type}.`
          )
        );
      });
    const pointRef = (x: number, y: number) =>
      Effect.gen(function* hitFakeControl() {
        yield* snapshot();
        const control = controls[Math.floor(y / 40)];
        if (x < 0 || x > 240 || control === undefined) {
          return yield* Effect.fail(
            makeBrowserRpcError(
              "agent_element_stale",
              "No control at this point."
            )
          );
        }
        const ref = refFor(control);
        yield* resolve(ref);
        return ref;
      });
    const tab: AgentBrowserTab = {
      beginObservation: () =>
        Effect.sync(() => {
          const before = atoms.get(state);
          return {
            observe: () =>
              snapshot().pipe(
                Effect.map((observed) => ({
                  effect:
                    atoms.get(state) === before
                      ? { kind: "none" as const }
                      : {
                          kind: "observed" as const,
                          signals: [
                            atoms.get(state).url === before.url
                              ? ("dom" as const)
                              : ("url" as const),
                          ],
                        },
                  snapshot: observed,
                }))
              ),
          };
        }),
      enterPrivate: (target, value) =>
        Effect.gen(function* enterFakePrivateValue() {
          const control = controls.find(
            (candidate) => candidate.key === target.selector
          );
          if (control === undefined) {
            return yield* Effect.fail(
              makeBrowserRpcError(
                "agent_element_stale",
                "Private control is stale."
              )
            );
          }
          yield* perform({ ref: refFor(control), text: value, type: "fill" });
          return target.selector;
        }),
      inspect: (x, y) =>
        pointRef(x, y).pipe(
          Effect.map((ref) => ({
            rectangle: {
              height: 40,
              width: 240,
              x: 0,
              y: Math.floor(y / 40) * 40,
            },
            ref,
          }))
        ),
      perform,
      screenshot: () =>
        Effect.fail(
          makeBrowserRpcError(
            "agent_browser_failed",
            "The in-memory site has no rendered pixels."
          )
        ),
      settledSnapshot: snapshot,
      snapshot,
      snapshotAfter: snapshot,
      url: () => atoms.get(state).url,
    };
    const browser: AgentBrowser = {
      active: () => Effect.succeed(tab),
      currentRef: (ref) => resolve(ref).pipe(Effect.map(refFor)),
      describe: (ref) => references.get(ref)?.control,
      enforceNavigation: (next) =>
        Effect.sync(() => {
          policy = next;
        }),
      focusedRef: () =>
        Effect.suspend(() => {
          const control = controls.find(
            (candidate) => candidate.key === atoms.get(state).focused
          );
          return control === undefined
            ? Effect.fail(stale("focused"))
            : resolve(refFor(control)).pipe(Effect.map(refFor));
        }),
      hasFocus: (ref) =>
        resolve(ref).pipe(
          Effect.map((control) => atoms.get(state).focused === control.key),
          Effect.orElseSucceed(() => false)
        ),
      isSensitive: (ref) =>
        resolve(ref).pipe(Effect.map((control) => control.sensitive ?? false)),
      pointRef,
      privateSelector: (ref) =>
        resolve(ref).pipe(
          Effect.map((control) => ({
            selector: control.key,
            spread: undefined,
          }))
        ),
      sameElement: (left, right) =>
        Effect.all([resolve(left), resolve(right)]).pipe(
          Effect.map(([a, b]) => a === b),
          Effect.orElseSucceed(() => false)
        ),
      valueDigest: (ref) =>
        resolve(ref).pipe(
          Effect.map((control) =>
            createHash("sha256")
              .update(atoms.get(state).values.get(control.key) ?? "")
              .digest("hex")
          )
        ),
    };
    return browser;
  });
