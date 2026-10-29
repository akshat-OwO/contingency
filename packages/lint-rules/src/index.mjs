/**
 * Contingency's own lint rules. `no-test-wait` keeps tests deterministic: a
 * test waits on the event it asserts, never on the wall clock, so it gives the
 * same verdict on a fast laptop and a starved CI runner. See
 * `docs/agents/testing.md`.
 */

const REAL_TIME_EFFECTS = new Set(["delay", "sleep"]);
const REAL_TIME_SCHEDULES = new Set([
  "exponential",
  "fibonacci",
  "fixed",
  "spaced",
  "windowed",
]);
const TIMERS = new Set(["setInterval", "setTimeout"]);
const SLEEP_HELPER = /^(?:sleep|delay)(?:Async|For|Ms|Millis|Milliseconds)?$/u;
const memberName = (node) => {
  if (node.type !== "MemberExpression") {
    return null;
  }
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return node.computed && node.property.type === "Literal"
    ? node.property.value
    : null;
};

const objectName = (node) =>
  node.type === "MemberExpression" && node.object.type === "Identifier"
    ? node.object.name
    : null;

/** The wall-clock wait a call starts, if any. */
const realTimeWait = (callee, imports) => {
  if (callee.type === "Identifier") {
    const imported = imports.get(callee.name);
    return TIMERS.has(callee.name) ||
      SLEEP_HELPER.test(callee.name) ||
      imported?.wait
      ? callee.name
      : null;
  }
  const name = memberName(callee);
  const owner = imports.get(objectName(callee))?.owner ?? objectName(callee);
  if (owner === "Effect" && REAL_TIME_EFFECTS.has(name)) {
    return `Effect.${name}`;
  }
  if (owner === "Schedule" && REAL_TIME_SCHEDULES.has(name)) {
    return `Schedule.${name}`;
  }
  if (["globalThis", "window", "self"].includes(owner) && TIMERS.has(name)) {
    return `globalThis.${name}`;
  }
  return name === "waitForTimeout" || (name !== null && SLEEP_HELPER.test(name))
    ? name
    : null;
};

const noTestWait = {
  create(context) {
    const imports = new Map();
    return {
      CallExpression(node) {
        const wait = realTimeWait(node.callee, imports);
        if (wait !== null) {
          context.report({ data: { wait }, messageId: "wait", node });
        }
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        const owner = new Map([
          ["effect/Effect", "Effect"],
          ["effect/Schedule", "Schedule"],
        ]).get(source);
        for (const specifier of node.specifiers) {
          const name =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.name
              : null;
          const wait =
            (name !== null && SLEEP_HELPER.test(name)) ||
            (owner === "Schedule" && REAL_TIME_SCHEDULES.has(name));
          if (
            wait ||
            owner !== undefined ||
            (source === "effect" && ["Effect", "Schedule"].includes(name))
          ) {
            imports.set(specifier.local.name, { owner: owner ?? name, wait });
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Tests wait on the event they assert, not on real time.",
    },
    messages: {
      wait: "`{{wait}}` waits on real time, so the verdict depends on the runner's speed. Wait for the event the next assertion reads, or use `it.effect` and `TestClock`. See docs/agents/testing.md.",
    },
    type: "problem",
  },
};

export default {
  meta: { name: "contingency" },
  rules: { "no-test-wait": noTestWait },
};
