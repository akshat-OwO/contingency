import { codeTargets } from "./code-targets.mjs";
import { Predicate, unpack } from "./runtime.mjs";

const actionOperation =
  /^(?:agent_browser_(?:act|act_sequence|resume)|agent_variable_enter)$/u;
const refsIn = (text) =>
  [
    ...String(text).matchAll(/(?:@|["']?ref["']?\s*:\s*["'])(?<ref>e\d+)/gu),
  ].map((match) => match.groups.ref);
const snapshotsIn = (value) => {
  if (!Predicate.isObject(value)) {
    return [];
  }
  if (value.snapshotId && (value.nodes || value.text)) {
    return [value];
  }
  return Object.values(value).flatMap(snapshotsIn);
};
const choose = (state, request, tool, refs, receipt) => {
  if (!actionOperation.test(tool)) {
    return;
  }
  const common = { at: request.at, id: request.message.id, tool };
  if (receipt) {
    common.receipt = receipt;
  }
  if (state.needsRead) {
    state.choices.push({ ...common, rule: 3 });
  }
  if (refs.some((ref) => state.stale.has(ref))) {
    state.choices.push({ ...common, refs, rule: 4 });
  }
};
const requestEvent = (state, event) => {
  const { message } = event;
  const request = {
    at: event.at,
    message,
    needsRead: state.needsRead,
    source: message.params.arguments?.code,
    stale: new Set(state.stale),
  };
  state.requests.set(message.id, request);
  if (message.params.name !== "agent_code_execute") {
    choose(
      state,
      request,
      message.params.name,
      refsIn(JSON.stringify(message.params.arguments))
    );
  }
};
const programAnswer = (state, request, body) => {
  const local = {
    ...state,
    needsRead: request.needsRead,
    stale: request.stale,
  };
  const calls = codeTargets(request.source);
  const used = new Map();
  for (const receipt of body.receipts ?? []) {
    if (
      receipt.operation === "agent_session_get" &&
      receipt.outcome === "succeeded"
    ) {
      local.needsRead = false;
      state.needsRead = false;
    }
    const ordinal = used.get(receipt.operation) ?? 0;
    used.set(receipt.operation, ordinal + 1);
    const call = calls.filter((item) => item.name === receipt.operation)[
      ordinal
    ];
    const refs = call?.refs ?? [];
    if (
      local.stale.size &&
      actionOperation.test(receipt.operation) &&
      (!call || call.unresolved)
    ) {
      state.choices.push({
        at: request.at,
        id: request.message.id,
        receipt,
        reviewRequired:
          "Unresolved program target; inspect code and Snapshot provenance",
        rule: null,
      });
    }
    choose(local, request, receipt.operation, refs, receipt);
  }
};
const answerEvent = (state, event) => {
  const request = state.requests.get(event.message.id);
  if (!request) {
    return;
  }
  let body;
  try {
    body = unpack(event.message);
  } catch {
    return;
  }
  if (request.message.params.name === "agent_session_get") {
    state.needsRead = false;
  }
  if (request.message.params.name === "agent_code_execute") {
    programAnswer(state, request, body);
  }
  for (const snapshot of snapshotsIn(body)) {
    const refs = [
      ...(snapshot.nodes ?? []).map((node) => node.ref).filter(Boolean),
      ...refsIn(snapshot.text ?? ""),
    ];
    for (const ref of refs) {
      state.observed.add(ref);
      state.stale.delete(ref);
    }
  }
  if (body.intervention || body.stopped?.reason === "intervention") {
    state.needsRead = true;
  }
};
const userEvent = (state, event) => {
  if (["intervention", "refusal", "return-control"].includes(event.kind)) {
    state.needsRead = true;
  }
  if (event.kind === "return-control" || event.kind === "stale-notice") {
    state.stale = new Set([...state.stale, ...state.observed]);
    state.observed = new Set();
  }
};
// Choices are counted per submitted native call or dispatched program receipt.
// Failed rereads do not reset R3. A Snapshot refreshes only references it carries.
export const classifyTimeline = (traffic, timeline) => {
  if (!timeline.length) {
    return [];
  }
  const events = [
    ...timeline.map((event) => ({ ...event, timeline: true })),
    ...traffic,
  ].toSorted((left, right) => String(left.at).localeCompare(String(right.at)));
  const state = {
    choices: [],
    needsRead: false,
    observed: new Set(),
    requests: new Map(),
    stale: new Set(),
  };
  for (const event of events) {
    if (event.timeline) {
      userEvent(state, event);
    } else if (
      event.direction === "request" &&
      event.message.method === "tools/call"
    ) {
      requestEvent(state, event);
    } else if (event.direction === "answer") {
      answerEvent(state, event);
    }
  }
  return state.choices;
};
