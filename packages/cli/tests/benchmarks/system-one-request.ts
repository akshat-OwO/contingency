/**
 * The System One request a fast browser loop sends: a Browser Snapshot turned
 * into a numbered action space, and the typed questions one Flow Skill step
 * asks of it. Shared by the Jev benchmark and the Kev training-data crawler,
 * so a trained model sees exactly the requests the loop sends.
 */
import { AgentElementRef } from "@contingency/protocol";
import type {
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentSnapshotNode,
} from "@contingency/protocol";
import { Schema } from "effect";

export const PAGE_LINE_LIMIT = 120;
export const RECENT_ACTION_LIMIT = 6;
export const NEXT = "next_";

// ---------------------------------------------------------------------------
// The System One wire format (https://docs.typesafe.ai/api)

export const ChoiceAnswerSchema = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Finite,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  type: Schema.Literal("choice"),
});
export const NoulAnswerSchema = Schema.Struct({
  noul: Schema.Finite,
  type: Schema.Literal("noul"),
});
export const SystemOneResponseSchema = Schema.Struct({
  answers: Schema.Record(
    Schema.String,
    Schema.Union([ChoiceAnswerSchema, NoulAnswerSchema])
  ),
  model: Schema.String,
  usage: Schema.Struct({
    input_tokens: Schema.Int,
    output_tokens: Schema.Int,
  }),
});
export type ChoiceAnswer = typeof ChoiceAnswerSchema.Type;
export type SystemOneResponse = typeof SystemOneResponseSchema.Type;

export interface NoulQuestion {
  readonly criteria: { readonly false: string; readonly true: string };
  readonly instructions: {
    readonly condition: string;
    readonly question: string;
  };
  readonly type: "noul";
}

export interface ChoiceQuestion {
  readonly criteria: Readonly<Record<string, string>>;
  readonly instructions: { readonly question: string; readonly step: string };
  readonly type: "choice";
}

export type Question = ChoiceQuestion | NoulQuestion;

export interface SnapshotElement {
  readonly checked?: boolean;
  readonly index: string;
  readonly name: string;
  readonly role: string;
  readonly value?: string;
  readonly within?: string;
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface SystemOneRequest {
  readonly model: string;
  /** Keyed by the answer name the loop reads back. */
  readonly questions: Readonly<Record<string, Question>>;
  readonly state: {
    readonly elements: readonly SnapshotElement[];
    readonly page: {
      readonly content: readonly string[];
      readonly title: string;
      readonly url: string;
    };
    readonly recent_actions: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Snapshot → indexed action space

export type Operation = "CLICK" | "FILL" | "SELECT";

export interface Candidate {
  readonly action: (value: string) => AgentBrowserAction;
  readonly describe: string;
}

export interface ActionSpace {
  readonly elements: readonly SnapshotElement[];
  readonly page: readonly string[];
  readonly targets: ReadonlyMap<Operation, ReadonlyMap<string, Candidate>>;
}

export const CLICK_ROLES = new Set([
  "button",
  "checkbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
]);
export const FILL_ROLES = new Set(["searchbox", "spinbutton", "textbox"]);

export const describeElement = (
  node: AgentSnapshotNode,
  index: string
): SnapshotElement => {
  const element: Mutable<SnapshotElement> = {
    index,
    name: node.name,
    role: node.role,
  };
  if (node.context !== undefined && node.context !== null) {
    element.within = node.context;
  }
  if (node.value !== undefined && node.value !== null) {
    element.value = node.value;
  }
  if (node.checked !== undefined && node.checked !== null) {
    element.checked = node.checked;
  }
  return element;
};

/** Which operation an element accepts, if any. */
export const operationFor = (
  node: AgentSnapshotNode
): Operation | undefined => {
  // A native select lists no options in the Snapshot, so its value comes
  // from the Flow Skill's inputs, like a filled field's.
  if (node.role === "combobox") {
    return "SELECT";
  }
  if (FILL_ROLES.has(node.role) && node.valueWithheld !== true) {
    return "FILL";
  }
  if (CLICK_ROLES.has(node.role) || node.clickable === true) {
    return "CLICK";
  }
  return undefined;
};

export const actionFor = (
  operation: Operation,
  ref: AgentElementRef
): Candidate["action"] => {
  if (operation === "SELECT") {
    return (value) => ({ ref, type: "select", values: [value] });
  }
  if (operation === "FILL") {
    return (value) => ({ ref, text: value, type: "fill" });
  }
  return () => ({ ref, type: "click" });
};

export const actionSpace = (snapshot: AgentBrowserSnapshot): ActionSpace => {
  const elements: SnapshotElement[] = [];
  const page: string[] = [];
  const targets = new Map<Operation, Map<string, Candidate>>();
  for (const node of snapshot.nodes) {
    const operation =
      node.interactive === true && node.disabled !== true
        ? operationFor(node)
        : undefined;
    if (operation === undefined) {
      if (node.name.trim() !== "" && page.length < PAGE_LINE_LIMIT) {
        page.push(`${node.role}: ${node.name}`);
      }
      continue;
    }
    const index = String(elements.length + 1);
    elements.push(describeElement(node, index));
    const candidates = targets.get(operation) ?? new Map<string, Candidate>();
    candidates.set(index, {
      action: actionFor(operation, AgentElementRef.make(node.ref)),
      describe: `[${index}] ${node.role} "${node.name}"`,
    });
    targets.set(operation, candidates);
  }
  return { elements, page, targets };
};

// ---------------------------------------------------------------------------
// One System One request per cycle

export const OPERATION_CRITERIA: Readonly<
  Record<Operation | "BLOCKED", string>
> = {
  BLOCKED: "No listed element can make progress on the step.",
  CLICK: "Click a button, link, checkbox, tab, or other control.",
  FILL: "Type one of the provided input values into a text field.",
  SELECT: "Choose one of the provided input values in a dropdown list.",
};

export const targetKey = (operation: Operation) =>
  `${operation.toLowerCase()}_target`;
export const valueKey = (index: string) => `value_${index}`;

export interface Cue {
  readonly doneWhen: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly instruction: string;
  readonly step: number;
}

/** The questions one step asks of the page, under an answer-name prefix. */
export const cueQuestions = (
  cue: Cue,
  space: ActionSpace,
  prefix: string
): (readonly [string, Question])[] => {
  const operations: Record<string, string> = {};
  for (const operation of space.targets.keys()) {
    operations[operation] = OPERATION_CRITERIA[operation];
  }
  operations["BLOCKED"] = OPERATION_CRITERIA.BLOCKED;
  const questions: (readonly [string, Question])[] = [
    [
      `${prefix}done`,
      {
        criteria: {
          false: "The page does not show this yet, or shows something else.",
          true: "The page visibly shows exactly this outcome now.",
        },
        instructions: {
          condition: cue.doneWhen,
          question: "Does the current `page` satisfy `condition`?",
        },
        type: "noul",
      },
    ],
    [
      `${prefix}operation`,
      {
        criteria: operations,
        instructions: {
          question:
            "Which operation is the single next action toward `step`? Do not repeat an action in `recent_actions` that already took effect.",
          step: cue.instruction,
        },
        type: "choice",
      },
    ],
  ];
  for (const [operation, candidates] of space.targets) {
    questions.push([
      `${prefix}${targetKey(operation)}`,
      {
        criteria: Object.fromEntries(
          [...candidates].map(([key, candidate]) => [key, candidate.describe])
        ),
        instructions: {
          question: `If the next action is ${operation}, which target does \`step\` call for?`,
          step: cue.instruction,
        },
        type: "choice",
      },
    ]);
    if (operation === "CLICK" || Object.keys(cue.inputs).length === 0) {
      continue;
    }
    // One value question per field, so a value is matched to its own field.
    for (const [index, candidate] of candidates) {
      questions.push([
        `${prefix}${valueKey(index)}`,
        {
          criteria: cue.inputs,
          instructions: {
            question: `Which input value does \`step\` put in ${candidate.describe}?`,
            step: cue.instruction,
          },
          type: "choice",
        },
      ]);
    }
  }
  return questions;
};

export const buildRequest = (
  model: string,
  cues: { readonly current: Cue; readonly next: Cue | undefined },
  space: ActionSpace,
  snapshot: AgentBrowserSnapshot,
  recent: readonly string[]
): SystemOneRequest => ({
  model,
  questions: Object.fromEntries([
    ...cueQuestions(cues.current, space, ""),
    ...(cues.next === undefined ? [] : cueQuestions(cues.next, space, NEXT)),
  ]),
  state: {
    elements: space.elements,
    page: {
      content: space.page,
      title: snapshot.title,
      url: snapshot.url,
    },
    recent_actions: recent.slice(-RECENT_ACTION_LIMIT),
  },
});
