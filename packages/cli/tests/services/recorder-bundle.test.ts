import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

class FakeElement {
  static root: FakeElement;
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[] = [];
  readonly documentElement = {
    append: (...elements: FakeElement[]) => {
      for (const element of elements) {
        element.isConnected = true;
      }
      this.children.push(...elements);
    },
  };
  readonly id = "";
  isConnected = true;
  readonly localName: string;
  readonly parentElement: FakeElement | null = null;
  readonly style: Record<string, string> = {};
  textContent = "";
  readonly value: string;

  constructor(
    localName: string,
    attributes: Readonly<Record<string, string>> = {},
    value = ""
  ) {
    this.attributes = { ...attributes };
    this.localName = localName;
    this.value = value;
  }

  createElement(localName: string): FakeElement {
    void this;
    const element = new FakeElement(localName);
    element.isConnected = false;
    return element;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  getBoundingClientRect(): {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  } {
    void this;
    return { height: 48, left: 20, top: 40, width: 160 };
  }

  getClientRects(): readonly unknown[] {
    return [this.getBoundingClientRect()];
  }

  getRootNode(): FakeElement {
    void this;
    return FakeElement.root;
  }

  remove(): void {
    this.isConnected = false;
  }

  querySelectorAll(): readonly FakeElement[] {
    void this;
    return [new FakeElement("input")];
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

const documentNode = new FakeElement("document");
FakeElement.root = documentNode;

it.effect("keeps sensitive values inside the isolated recorder bundle", () =>
  Effect.gen(function* protectSensitiveValue() {
    const source = yield* Effect.tryPromise(() =>
      readFile(
        path.resolve(import.meta.dirname, "../../assets/recorder/injected.js"),
        "utf-8"
      )
    );
    const emitted: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const removed = new Set<string>();
    const clearedTimers = new Set<number>();
    const timers = new Map<number, () => void>();
    let nextTimerId = 1;
    const context = vm.createContext({
      CSS: { escape: (value: string) => value },
      Document: FakeElement,
      Element: FakeElement,
      HTMLInputElement: FakeElement,
      HTMLSelectElement: FakeElement,
      HTMLTextAreaElement: FakeElement,
      ShadowRoot: FakeElement,
      __CONTINGENCY_BINDING__: (payload: string) => emitted.push(payload),
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, listener);
      },
      cancelAnimationFrame: () => null,
      clearTimeout: (timerId: number) => {
        clearedTimers.add(timerId);
        timers.delete(timerId);
      },
      document: documentNode,
      removeEventListener: (name: string) => {
        removed.add(name);
      },
      requestAnimationFrame: (handler: () => void) => {
        handler();
        return 1;
      },
      setTimeout: (handler: () => void) => {
        const timerId = nextTimerId;
        nextTimerId += 1;
        timers.set(timerId, handler);
        return timerId;
      },
    });
    new vm.Script(source).runInContext(context);

    const input = new FakeElement(
      "input",
      { inputmode: "numeric", maxlength: "6" },
      "987654"
    );
    listeners.get("input")?.({ isTrusted: true, target: input });
    timers.get(1)?.();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).not.toContain("987654");
    expect(emitted[0]).toContain("{{SECRET}}");

    const credential = new FakeElement(
      "input",
      { name: "refresh_token" },
      "refresh-secret-value"
    );
    listeners.get("input")?.({ isTrusted: true, target: credential });
    timers.get(2)?.();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).not.toContain("refresh-secret-value");
    expect(emitted[1]).toContain("{{REFRESH_TOKEN}}");

    expect(source).toContain("xpath//");
    expect(source).toContain("pierce/");

    const inspected = new FakeElement("button", {
      "aria-expanded": "false",
      "aria-label": "Continue",
      role: "button",
    });
    listeners.get("mousemove")?.({
      composedPath: () => [inspected],
      isTrusted: true,
    });
    const [inspector, inspectorLabel] = documentNode.children;
    expect(inspector?.style.display).toBe("block");
    expect(inspectorLabel?.textContent).toContain("button · 160 × 48");
    expect(inspectorLabel?.textContent).toContain("role=button");
    expect(inspectorLabel?.textContent).toContain("aria-label=Continue");

    const pendingInput = new FakeElement("input", {}, "ordinary draft");
    listeners.get("input")?.({ isTrusted: true, target: pendingInput });

    new vm.Script("globalThis.__contingencyRecorderCleanup()").runInContext(
      context
    );
    expect(clearedTimers).toContain(3);
    expect(removed).toEqual(
      new Set([
        "blur",
        "beforeunload",
        "click",
        "input",
        "keydown",
        "keyup",
        "mouseleave",
        "mousemove",
      ])
    );
  })
);
