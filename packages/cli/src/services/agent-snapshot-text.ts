import type {
  AgentBrowserSnapshot,
  AgentSnapshotNode,
} from "@contingency/protocol";

/**
 * Whether an action is meant to name this node. Only these carry a reference
 * in the text form: text and landmarks describe where a control sits, and a
 * reference on every paragraph is a token the agent pays for and never uses.
 */
const isActionable = (node: AgentSnapshotNode): boolean =>
  node.interactive === true || node.clickable === true;

const stateOf = (node: AgentSnapshotNode): string[] => {
  const state: string[] = [];
  if (node.disabled) {
    state.push("disabled");
  }
  if (node.checked !== undefined) {
    state.push(node.checked ? "checked" : "unchecked");
  }
  if (node.clickable) {
    state.push("clickable");
  }
  if (node.valueWithheld) {
    state.push("value withheld");
  } else if (node.value !== undefined && node.value !== "") {
    state.push(`value=${JSON.stringify(node.value)}`);
  }
  if (node.context !== undefined) {
    state.push(`context=${JSON.stringify(node.context)}`);
  }
  if (node.url !== undefined) {
    state.push(`url=${node.url}`);
  }
  return state;
};

/** One node as one line: indentation, reference, role, name, and state. */
const lineOf = (node: AgentSnapshotNode): string => {
  const state = stateOf(node);
  return [
    "  ".repeat(node.depth),
    isActionable(node) ? `@${node.ref} ` : "",
    node.role,
    node.name === "" ? "" : ` ${JSON.stringify(node.name)}`,
    state.length === 0 ? "" : ` [${state.join(" ")}]`,
  ].join("");
};

/** The nodes of an already-redacted Snapshot, one line each. */
export const snapshotLines = (snapshot: AgentBrowserSnapshot): string =>
  snapshot.nodes.map(lineOf).join("\n");

/** The text form: the same observation with its nodes rendered as lines. */
export const textSnapshot = (
  snapshot: AgentBrowserSnapshot
): AgentBrowserSnapshot => ({
  ...snapshot,
  nodes: [],
  text: snapshotLines(snapshot),
});

/**
 * The lines that changed between two text Snapshots of one Page. References
 * survive across reads of the same document, so an unchanged control renders
 * the same line and drops out; a control the Page replaced reads as removed
 * and added. Lines are compared as a multiset, so a list of identical rows
 * that grew by one reports one added row.
 */
export const diffSnapshotLines = (previous: string, next: string): string => {
  const remaining = new Map<string, number>();
  const previousLines = previous === "" ? [] : previous.split("\n");
  for (const line of previousLines) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  const added: string[] = [];
  let unchanged = 0;
  for (const line of next === "" ? [] : next.split("\n")) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
      unchanged += 1;
    } else {
      added.push(line);
    }
  }
  const removed: string[] = [];
  for (const line of previousLines) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) {
      remaining.set(line, count - 1);
      removed.push(line);
    }
  }
  return [
    `diff: ${added.length} added, ${removed.length} removed, ${unchanged} unchanged`,
    ...added.map((line) => `+ ${line}`),
    ...removed.map((line) => `- ${line}`),
  ].join("\n");
};

/**
 * Whether a Snapshot read the whole document, so a later read can be compared
 * with it. A scoped, filtered, or continued read describes only part of the
 * Page, and so does a truncated one: which nodes fit its budget depends on
 * what the viewport shows, so a scroll alone would read as change.
 */
export const isWholePage = (snapshot: AgentBrowserSnapshot): boolean =>
  snapshot.coverage === undefined ||
  (snapshot.coverage.offset === 0 &&
    !snapshot.coverage.truncated &&
    snapshot.coverage.selector === null &&
    snapshot.coverage.interactive !== true);
