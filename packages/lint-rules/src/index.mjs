/**
 * Contingency's own lint rules. `no-test-wait` keeps tests deterministic: a
 * test waits on the event it asserts, never on the wall clock, so it gives the
 * same verdict on a fast laptop and a starved CI runner. See
 * `docs/agents/testing.md`. `fixed-log-message` keeps the Diagnostic Log safe
 * to share, and `no-silent-ignore` keeps every discarded failure in it.
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

const LOG_FUNCTIONS = new Set([
  "log",
  "logDebug",
  "logError",
  "logFatal",
  "logInfo",
  "logTrace",
  "logWarning",
]);

/** A message the Diagnostic Log can keep: a literal with no interpolation. */
const isFixedMessage = (node) =>
  (node.type === "Literal" && /^["']/u.test(node.raw ?? "")) ||
  (node.type === "TemplateLiteral" && node.expressions.length === 0);

/**
 * `fixed-log-message` keeps the Diagnostic Log safe to share as-is (ADR
 * 0089). A message is a fixed string; every value that changes goes in an
 * annotation, where the log's allowlist decides how it renders.
 */
const fixedLogMessage = {
  create(context) {
    const effectNames = new Set(["Effect"]);
    const logImports = new Set();
    return {
      CallExpression(node) {
        const { callee } = node;
        const isLog =
          (callee.type === "MemberExpression" &&
            effectNames.has(objectName(callee)) &&
            LOG_FUNCTIONS.has(memberName(callee))) ||
          (callee.type === "Identifier" && logImports.has(callee.name));
        const [first] = node.arguments;
        if (isLog && first !== undefined && !isFixedMessage(first)) {
          context.report({ messageId: "message", node: first });
        }
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        for (const specifier of node.specifiers) {
          const local = specifier.local.name;
          const imported =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.name
              : null;
          if (source === "effect" && imported === "Effect") {
            effectNames.add(local);
          }
          if (source === "effect/Effect") {
            if (specifier.type === "ImportNamespaceSpecifier") {
              effectNames.add(local);
            } else if (LOG_FUNCTIONS.has(imported)) {
              logImports.add(local);
            }
          }
        }
      },
    };
  },
  meta: {
    docs: {
      description:
        "Log messages are fixed strings, so the log stays share-safe.",
    },
    messages: {
      message:
        'Log a fixed string and put each changing value in an annotation, such as `Effect.logWarning("Run footage stopped", { error })`. The Diagnostic Log renders annotations through an allowlist. See docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md.',
    },
    type: "problem",
  },
};

const IGNORE_FUNCTIONS = new Set(["ignore", "ignoreCause"]);

const propertyNamed = (object, name) =>
  object.properties.find(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === name) ||
        (property.key.type === "Literal" && property.key.value === name))
  );

/** Whether an `ignore` call's options log the failure under a fixed message. */
const logsWithFixedMessage = (call) => {
  const options = call.arguments.find(
    (argument) => argument.type === "ObjectExpression"
  );
  if (options === undefined) {
    return false;
  }
  const log = propertyNamed(options, "log");
  const message = propertyNamed(options, "message");
  return (
    log !== undefined &&
    !(log.value.type === "Literal" && log.value.value === false) &&
    message !== undefined &&
    isFixedMessage(message.value)
  );
};

/**
 * `no-silent-ignore` keeps every discarded failure in the Diagnostic Log
 * (ADR 0089). `Effect.ignore` and `Effect.ignoreCause` must log what they
 * drop, at a level and under a fixed message, so a later failure can be
 * traced to the one that was swallowed.
 */
const noSilentIgnore = {
  create(context) {
    const effectNames = new Set(["Effect"]);
    const ignoreImports = new Set();
    const check = (node, name) => {
      const { parent } = node;
      const called = parent?.type === "CallExpression" && parent.callee === node;
      if (!(called && logsWithFixedMessage(parent))) {
        context.report({ data: { name }, messageId: "silent", node });
      }
    };
    return {
      Identifier(node) {
        if (
          ignoreImports.has(node.name) &&
          node.parent?.type !== "ImportSpecifier"
        ) {
          check(node, node.name);
        }
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        for (const specifier of node.specifiers) {
          const local = specifier.local.name;
          const imported =
            specifier.type === "ImportSpecifier"
              ? specifier.imported.name
              : null;
          if (source === "effect" && imported === "Effect") {
            effectNames.add(local);
          }
          if (source === "effect/Effect") {
            if (specifier.type === "ImportNamespaceSpecifier") {
              effectNames.add(local);
            } else if (IGNORE_FUNCTIONS.has(imported)) {
              ignoreImports.add(local);
            }
          }
        }
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (effectNames.has(objectName(node)) && IGNORE_FUNCTIONS.has(name)) {
          check(node, `Effect.${name}`);
        }
      },
    };
  },
  meta: {
    docs: {
      description: "Discarded failures are logged under a fixed message.",
    },
    messages: {
      silent:
        '`{{name}}` drops a failure without a trace. Log it, such as `Effect.ignore({ log: "Debug", message: "Could not remove the lock file" })`. See docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md.',
    },
    type: "problem",
  },
};

export default {
  meta: { name: "contingency" },
  rules: {
    "fixed-log-message": fixedLogMessage,
    "no-silent-ignore": noSilentIgnore,
    "no-test-wait": noTestWait,
  },
};
