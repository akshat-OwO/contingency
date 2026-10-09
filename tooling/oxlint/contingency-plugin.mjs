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
const TIMER_MODULES = new Set(["node:timers/promises", "timers/promises"]);
const REAL_TIME_IMPORTS = new Set(["scheduler", "setInterval", "setTimeout"]);
/** Callbacks handed to these run inside the browser Page, not the test. */
const PAGE_CALLS = new Set([
  "$$eval",
  "$eval",
  "addInitScript",
  "evaluate",
  "evaluateHandle",
  "waitForFunction",
]);

const memberName = (node) =>
  node.type === "MemberExpression" &&
  !node.computed &&
  node.property.type === "Identifier"
    ? node.property.name
    : undefined;

const objectName = (node) =>
  node.type === "MemberExpression" && node.object.type === "Identifier"
    ? node.object.name
    : undefined;

const isFunction = (node) =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

/** Whether the node sits in a function the test ships to the Page. */
const runsInPage = (node) => {
  for (let child = node; child.parent; child = child.parent) {
    const { parent } = child;
    if (
      isFunction(child) &&
      parent.type === "CallExpression" &&
      parent.arguments.includes(child) &&
      PAGE_CALLS.has(memberName(parent.callee))
    ) {
      return true;
    }
  }
  return false;
};

/** The wall-clock wait a call starts, if any. */
const realTimeWait = (callee) => {
  if (callee.type === "Identifier") {
    return TIMERS.has(callee.name) ? callee.name : null;
  }
  const name = memberName(callee);
  const owner = objectName(callee);
  if (owner === "Effect" && REAL_TIME_EFFECTS.has(name)) {
    return `Effect.${name}`;
  }
  if (owner === "Schedule" && REAL_TIME_SCHEDULES.has(name)) {
    return `Schedule.${name}`;
  }
  if (owner === "globalThis" && TIMERS.has(name)) {
    return `globalThis.${name}`;
  }
  return name === "waitForTimeout" ? name : null;
};

const noTestWait = {
  create(context) {
    return {
      CallExpression(node) {
        const wait = realTimeWait(node.callee);
        if (wait !== null && !runsInPage(node)) {
          context.report({ data: { wait }, messageId: "wait", node });
        }
      },
      ImportDeclaration(node) {
        if (!TIMER_MODULES.has(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          // `setImmediate` yields one turn of the event loop; it waits on no clock.
          const imported =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.name
              : undefined;
          if (imported === undefined || REAL_TIME_IMPORTS.has(imported)) {
            context.report({
              data: { wait: `${node.source.value} ${imported ?? "*"}` },
              messageId: "wait",
              node: specifier,
            });
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
