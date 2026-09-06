import { AtomRegistry } from "effect/unstable/reactivity";
import { expect, test } from "vitest";

import { retainedFamily } from "@/lib/retained-state";

test("a key's value outlives every subscriber to it", () => {
  const family = retainedFamily<string>("");
  const registry = AtomRegistry.make();

  const unmount = registry.mount(family("rev-1"));
  registry.set(family("rev-1"), "typed");
  unmount();

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
