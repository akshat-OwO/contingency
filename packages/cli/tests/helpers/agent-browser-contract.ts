import type { BrowserRpcErrorType } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Scope } from "effect";

import type { AgentBrowser } from "../../src/services/agent-browser-contract.ts";

export const CONTRACT_HTML = `<!doctype html><title>Agent browser contract</title>
<style>body{margin:0}input,button{box-sizing:border-box;display:block;width:240px;height:40px}</style>
<input id="message" aria-label="Message"><input type="password" aria-label="Password">
<button onclick="document.querySelector('output').textContent='Saved'">Save</button>
<button onclick="document.querySelector('#message')?.remove()">Remove field</button><output role="status"></output>`;
export const CONTRACT_URL = `data:text/html,${encodeURIComponent(CONTRACT_HTML)}`;
export const CONTRACT_NEXT_URL = `data:text/html,${encodeURIComponent(CONTRACT_HTML.replace("contract</title>", "contract destination</title>"))}`;

/** Every adapter is judged through the same interface used by Agent Session. */
export const agentBrowserContract = <R = never>(
  name: string,
  make: () => Effect.Effect<AgentBrowser, BrowserRpcErrorType, R | Scope.Scope>,
  run: (
    test: Effect.Effect<unknown, unknown, R | Scope.Scope>
  ) => Effect.Effect<unknown, unknown, Scope.Scope>
) => {
  it.live(`${name}: observes and performs a settled action on a ref`, () =>
    run(
      Effect.gen(function* successfulAction() {
        const browser = yield* make();
        const tab = yield* browser.active();
        expect(yield* browser.active()).toBe(tab);
        const before = yield* tab.settledSnapshot();
        expect(before.title).toBe("Agent browser contract");
        const save = before.nodes.find((node) => node.name === "Save");
        expect(save).toBeDefined();
        if (save === undefined) {
          return;
        }
        const action = { ref: save.ref, type: "click" as const };
        const observation = yield* tab.beginObservation(action);
        yield* tab.perform(action);
        const after = yield* observation.observe();
        expect(after.snapshot.nodes.some((node) => node.name === "Saved")).toBe(
          true
        );
        expect(after.snapshot.settle?.settled).toBe(true);
        expect(after.effect?.kind).toBe("observed");
        expect(browser.describe(save.ref)).toMatchObject({
          name: "Save",
          role: "button",
        });
      })
    )
  );

  it.live(`${name}: refuses refs from a previous document`, () =>
    run(
      Effect.gen(function* staleAfterNavigation() {
        const browser = yield* make();
        const tab = yield* browser.active();
        const before = yield* tab.snapshot();
        const node = before.nodes.find(
          (candidate) => candidate.name === "Save"
        );
        expect(node).toBeDefined();
        if (node === undefined) {
          return;
        }
        yield* tab.perform({ type: "navigate", url: CONTRACT_NEXT_URL });
        const after = yield* tab.snapshotAfter(before.url);
        expect(after.url).toBe(CONTRACT_NEXT_URL);
        const failed = yield* Effect.flip(
          tab.perform({ ref: node.ref, type: "click" })
        );
        expect(failed.code).toBe("agent_element_stale");
        expect(yield* browser.sameElement(node.ref, node.ref)).toBe(false);
        expect(yield* browser.hasFocus(node.ref)).toBe(false);
      })
    )
  );

  it.live(`${name}: refuses a ref after its element is removed`, () =>
    run(
      Effect.gen(function* staleAfterMutation() {
        const browser = yield* make();
        const tab = yield* browser.active();
        const before = yield* tab.snapshot();
        const message = before.nodes.find((node) => node.name === "Message");
        const remove = before.nodes.find(
          (node) => node.name === "Remove field"
        );
        expect(message).toBeDefined();
        expect(remove).toBeDefined();
        if (message === undefined || remove === undefined) {
          return;
        }
        yield* tab.perform({ ref: remove.ref, type: "click" });
        const after = yield* tab.snapshotAfter(before.url);
        expect(after.nodes.some((node) => node.name === "Message")).toBe(false);
        expect(
          (yield* Effect.flip(
            tab.perform({ ref: message.ref, text: "lost", type: "fill" })
          )).code
        ).toBe("agent_element_stale");
        expect((yield* Effect.flip(browser.currentRef(message.ref))).code).toBe(
          "agent_element_stale"
        );
      })
    )
  );

  it.live(
    `${name}: inspects points and answers focus and sensitivity without exposing values`,
    () =>
      run(
        Effect.gen(function* pointFocusPrivacy() {
          const browser = yield* make();
          const tab = yield* browser.active();
          const inspected = yield* tab.inspect(50, 20);
          expect(browser.describe(inspected.ref)).toMatchObject({
            name: "Message",
            role: "textbox",
          });
          expect(inspected.rectangle.width).toBeGreaterThan(0);
          const snapshot = yield* tab.snapshot();
          const password = snapshot.nodes.find(
            (node) => node.name === "Password"
          );
          expect(password).toBeDefined();
          if (password === undefined) {
            return;
          }
          expect(yield* browser.isSensitive(inspected.ref)).toBe(false);
          expect(yield* browser.isSensitive(password.ref)).toBe(true);
          yield* tab.perform({
            ref: inspected.ref,
            text: "hello",
            type: "fill",
          });
          yield* tab.snapshotAfter(snapshot.url);
          const focused = yield* browser.focusedRef();
          expect(yield* browser.sameElement(inspected.ref, focused)).toBe(true);
          expect(yield* browser.hasFocus(focused)).toBe(true);
          expect(yield* browser.currentRef(inspected.ref)).toBe(focused);
          const digest = yield* browser.valueDigest(password.ref);
          const target = yield* browser.privateSelector(password.ref);
          yield* tab.enterPrivate(target, "disposable-secret");
          expect(yield* browser.valueDigest(password.ref)).not.toBe(digest);
          const privateSnapshot = yield* tab.snapshotAfter(snapshot.url);
          expect(
            privateSnapshot.nodes.find((node) => node.name === "Password")
              ?.valueWithheld
          ).toBe(true);
          expect(JSON.stringify(privateSnapshot)).not.toContain(
            "disposable-secret"
          );
        })
      )
  );

  it.live(
    `${name}: enforces navigation policy before leaving the document`,
    () =>
      run(
        Effect.gen(function* navigationPolicy() {
          const browser = yield* make();
          const refused: string[] = [];
          yield* browser.enforceNavigation({
            allows: (url) => url.startsWith("data:"),
            dispose: () => {
              /* Policy lifetime ends with the test fixture. */
            },
            refuse: (url) =>
              Effect.sync(() => {
                refused.push(url);
              }),
          });
          const tab = yield* browser.active();
          yield* Effect.flip(
            tab.perform({ type: "navigate", url: "https://blocked.example/" })
          );
          expect(refused).toContain("https://blocked.example/");
          expect(tab.url()).toBe(CONTRACT_URL);
          yield* tab.perform({ type: "navigate", url: CONTRACT_NEXT_URL });
          expect((yield* tab.snapshotAfter(CONTRACT_URL)).url).toBe(
            CONTRACT_NEXT_URL
          );
        })
      )
  );
};
