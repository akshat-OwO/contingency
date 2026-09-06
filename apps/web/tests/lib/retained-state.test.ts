import { setImmediate } from "node:timers/promises";

import { AtomRegistry } from "effect/unstable/reactivity";
import { expect, test } from "vitest";

import { retainedFamily } from "@/lib/retained-state";

/**
 * Unmounting only schedules the node for removal; the registry collects it on
 * the next tick. Reading synchronously after `unmount` therefore still sees
 * the value even without the retained store, so the wait is what makes this
 * an assertion about outliving collection rather than about timing.
 */
const collectIdleNodes = setImmediate;

test("a key's value outlives every subscriber to it", async () => {
  const family = retainedFamily<string>("");
  const registry = AtomRegistry.make();

  const unmount = registry.mount(family("rev-1"));
  registry.set(family("rev-1"), "typed");
  unmount();
  await collectIdleNodes();

  expect(registry.get(family("rev-1"))).toBe("typed");
});

test("keys the user has not returned to are dropped, so the store stays bounded", () => {
  const family = retainedFamily<string>("", 2);
  const registry = AtomRegistry.make();

  registry.set(family("rev-1"), "one");
  registry.set(family("rev-2"), "two");
  registry.set(family("rev-3"), "three");

  expect(registry.get(family("rev-1"))).toBe("");
  expect(registry.get(family("rev-2"))).toBe("two");
  expect(registry.get(family("rev-3"))).toBe("three");
});

test("returning to a key keeps it held while older keys age out", () => {
  const family = retainedFamily<string>("", 2);
  const registry = AtomRegistry.make();

  registry.set(family("rev-1"), "one");
  registry.set(family("rev-2"), "two");
  registry.set(family("rev-1"), "one again");
  registry.set(family("rev-3"), "three");

  expect(registry.get(family("rev-1"))).toBe("one again");
  expect(registry.get(family("rev-2"))).toBe("");
});
