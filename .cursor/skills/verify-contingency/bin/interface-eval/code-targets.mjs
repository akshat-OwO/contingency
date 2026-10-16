// Use the same installed Acorn parser as the confined interpreter. No code runs.
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cliRoot, Predicate } from "./runtime.mjs";

const codemode = await realpath(
  path.join(cliRoot, "node_modules/@opencode/codemode/package.json")
);
const { parse } = await import(
  pathToFileURL(createRequire(codemode).resolve("acorn")).href
);
const fresh = Symbol("fresh Snapshot data");
const unknown = Symbol("unresolved program data");
const property = (node) =>
  node.computed ? node.property.value : node.property.name;
const toolName = (node) =>
  node?.type === "MemberExpression" && node.object.name === "tools"
    ? property(node)
    : null;
const supportedProperty = (item) =>
  item.type === "Property" && (!item.computed || item.key.type === "Literal");
const resolve = (node, bindings) => {
  if (!node) {
    return unknown;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  if (node.type === "Identifier") {
    return bindings.get(node.name) ?? unknown;
  }
  if (node.type === "AwaitExpression") {
    return resolve(node.argument, bindings);
  }
  if (node.type === "ArrayExpression") {
    return node.elements.map((entry) => resolve(entry, bindings));
  }
  if (node.type === "ObjectExpression") {
    const value = {};
    for (const item of node.properties) {
      if (!supportedProperty(item)) {
        return unknown;
      }
      value[item.key.name ?? item.key.value] = resolve(item.value, bindings);
    }
    return value;
  }
  if (node.type === "MemberExpression") {
    const parent = resolve(node.object, bindings);
    if (parent === fresh) {
      return fresh;
    }
    return parent?.[property(node)] ?? unknown;
  }
  if (node.type === "CallExpression") {
    if (
      [
        "agent_browser_snapshot",
        "agent_browser_act",
        "agent_browser_act_sequence",
        "agent_variable_enter",
      ].includes(toolName(node.callee))
    ) {
      return fresh;
    }
    if (
      node.callee.type === "MemberExpression" &&
      resolve(node.callee.object, bindings) === fresh
    ) {
      return fresh;
    }
  }
  return unknown;
};
const refOf = (action) =>
  action === fresh || action === unknown ? action : action?.ref;
const targets = (name, params) => {
  if (params === fresh) {
    return { fresh: true, refs: [], unresolved: false };
  }
  if (params === unknown) {
    return { fresh: false, refs: [], unresolved: true };
  }
  let values;
  if (name === "agent_browser_act_sequence") {
    values = Array.isArray(params.actions)
      ? params.actions.map((entry) => refOf(entry.action ?? entry))
      : [unknown];
  } else if (name === "agent_browser_act") {
    values = [refOf(params.action)];
  } else if (name === "agent_variable_enter") {
    values = [params.ref];
  } else {
    return { fresh: false, refs: [], unresolved: false };
  }
  return {
    fresh: values.includes(fresh),
    refs: values.filter((value) => Predicate.isString(value)),
    unresolved: values.includes(unknown),
  };
};
// A call under one of these may run zero or many times, or out of source
// order, so a receipt cannot be matched to it by position.
const branching = new Set([
  "ArrowFunctionExpression",
  "ConditionalExpression",
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "FunctionDeclaration",
  "FunctionExpression",
  "IfStatement",
  "LogicalExpression",
  "SwitchStatement",
  "TryStatement",
  "WhileStatement",
]);
// Methods that change the object they are called on.
const mutating = new Set([
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const rootName = (node) => {
  let current = node;
  while (current?.type === "MemberExpression") {
    current = current.object;
  }
  return current?.type === "Identifier" ? current.name : null;
};
const contains = (value, target) =>
  value === target ||
  (Predicate.isObject(value) &&
    Object.values(value).some((item) => contains(item, target)));
export const codeTargets = (source) => {
  const calls = [];
  const bindings = new Map();
  // A write the visitor does not model makes the written value, and every
  // binding that shares it, unresolved. That includes Snapshot data: a fresh
  // node can be given a stale ref. Reads such as find() are not writes.
  const invalidate = (node) => {
    const name = rootName(node);
    if (name === null) {
      return;
    }
    const old = bindings.get(name);
    bindings.set(name, unknown);
    if (!Predicate.isObject(old)) {
      return;
    }
    for (const [key, value] of bindings) {
      if (contains(value, old)) {
        bindings.set(key, unknown);
      }
    }
  };
  // Writes other than plain assignment: updates, deletes, and mutating calls.
  const invalidateWrites = (node) => {
    if (
      node.type === "UpdateExpression" ||
      (node.type === "UnaryExpression" && node.operator === "delete")
    ) {
      invalidate(node.argument);
    }
    if (node.type !== "CallExpression" || toolName(node.callee)) {
      return;
    }
    const { callee } = node;
    if (callee.type !== "MemberExpression") {
      return;
    }
    if (mutating.has(property(callee))) {
      invalidate(callee.object);
    }
    if (
      callee.object.name === "Object" &&
      ["assign", "defineProperty", "defineProperties"].includes(
        property(callee)
      )
    ) {
      invalidate(node.arguments[0]);
    }
  };
  const bind = (name, node, branched) =>
    bindings.set(name, branched ? unknown : resolve(node, bindings));
  // `branched` is true under any construct that may skip, repeat, or reorder
  // a call relative to its source position.
  const visit = (node, branched = false) => {
    if (!node || !node.type) {
      return;
    }
    const inner = branched || branching.has(node.type);
    if (node.type === "VariableDeclarator") {
      visit(node.init, inner);
      if (node.id.type === "Identifier") {
        bind(node.id.name, node.init, inner);
      }
      return;
    }
    if (node.type === "AssignmentExpression") {
      visit(node.right, inner);
      if (node.left.type === "Identifier" && node.operator === "=") {
        bind(node.left.name, node.right, inner);
      } else {
        invalidate(node.left);
      }
      return;
    }
    invalidateWrites(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item, inner);
        }
      } else if (value?.type) {
        visit(value, inner);
      }
    }
    const name = node.type === "CallExpression" ? toolName(node.callee) : null;
    if (name) {
      calls.push({
        ...targets(name, resolve(node.arguments[0], bindings)),
        name,
        start: node.start,
        straightLine: !inner,
      });
    }
  };
  try {
    visit(
      parse(source ?? "", {
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        ecmaVersion: "latest",
      })
    );
  } catch {
    return [];
  }
  return calls.toSorted((left, right) => left.start - right.start);
};
