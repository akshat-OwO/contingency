import type {
  AndroidWorkspaceObservation,
  NativeInput,
  NativeTeachingInstruction,
} from "@contingency/protocol";

export type ObservedNode = AndroidWorkspaceObservation["nodes"][number];

/** Where an element sits on the screen, as fractions of the screen's size. */
export interface ScreenBox {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/** An element's box on the screen, or nothing without bounds. */
export const elementBox = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
): ScreenBox | undefined => {
  const { bounds } = node;
  if (
    bounds === undefined ||
    observation.width <= 0 ||
    observation.height <= 0
  ) {
    return undefined;
  }
  return {
    height: bounds.height / observation.height,
    left: bounds.x / observation.width,
    top: bounds.y / observation.height,
    width: bounds.width / observation.width,
  };
};

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "radio",
  "slider",
  "switch",
  "tab",
]);

const ELEMENT_GROUPS = [
  { id: "fields", title: "Fields" },
  { id: "controls", title: "Controls" },
  { id: "other", title: "Other elements" },
] as const;

/** Which part of the list an element belongs in. */
const elementGroup = (
  node: ObservedNode
): (typeof ELEMENT_GROUPS)[number]["id"] => {
  if (node.editable) {
    return "fields";
  }
  return CONTROL_ROLES.has(node.role.toLowerCase()) ? "controls" : "other";
};

/**
 * Fields and controls lead; text, images, and the system bar follow, so the
 * app's own inputs are at the top. Text or a container that repeats a label
 * already listed, such as a button's own text, is left out.
 */
export const groupElements = (
  labelled: readonly { readonly label: string; readonly node: ObservedNode }[]
) => {
  const listed = new Set<string>();
  return ELEMENT_GROUPS.map((group) => {
    const entries = labelled.filter((entry) => {
      if (
        elementGroup(entry.node) !== group.id ||
        (group.id === "other" && listed.has(entry.label))
      ) {
        return false;
      }
      listed.add(entry.label);
      return true;
    });
    return { ...group, entries };
  }).filter((group) => group.entries.length > 0);
};

const ROLE_WORDS = new Map([
  ["application", "app"],
  ["other", "element"],
  ["secure-text-field", "secure field"],
  ["text-field", "field"],
]);

/** A role as a short word a person reads, not the platform's identifier. */
export const roleWord = (role: string) =>
  ROLE_WORDS.get(role.toLowerCase()) ?? role.toLowerCase().replaceAll("-", " ");

/**
 * The system status bar (clock, signal, battery) sits in a screen's top few
 * percent on both platforms; it is not the app, so the list leaves out its
 * text and images. A field or control there is kept: it may be the app's.
 */
const STATUS_BAR_FRACTION = 0.07;
export const inStatusBar = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
) =>
  node.bounds !== undefined &&
  elementGroup(node) === "other" &&
  node.bounds.y + node.bounds.height <=
    observation.height * STATUS_BAR_FRACTION;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A tap at this element's centre, or nothing without bounds. */
export const elementTap = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
): readonly NativeInput[] | undefined => {
  const { bounds } = node;
  if (
    bounds === undefined ||
    observation.width <= 0 ||
    observation.height <= 0
  ) {
    return undefined;
  }
  const point = {
    x: clamp((bounds.x + bounds.width / 2) / observation.width),
    y: clamp((bounds.y + bounds.height / 2) / observation.height),
  };
  const at = performance.now();
  return [
    { _tag: "touch", action: "down", at, ...point },
    { _tag: "touch", action: "up", at, ...point },
  ];
};

/** The elements the list offers: on screen, placed, and not the status bar. */
export const listedNodes = (observation: AndroidWorkspaceObservation | null) =>
  observation === null
    ? []
    : observation.nodes.filter(
        (node) =>
          !node.covered &&
          !inStatusBar(observation, node) &&
          node.bounds !== undefined
      );

/** How many elements the list offers, for the rail's description. */
export const screenElementCount = (
  observation: AndroidWorkspaceObservation | null
) => listedNodes(observation).length;

/** An element's name as a person reads it, or its role when it has none. */
export const elementLabel = (node: ObservedNode) => {
  const name = node.name.trim();
  return name === "" ? `Unnamed ${roleWord(node.role)}` : name;
};

/**
 * The element a native comment holds: one node, by its target, of the
 * observation it was picked from. The server refuses it once the element
 * has left the screen.
 */
export interface AttachedElement {
  readonly box: ScreenBox | undefined;
  readonly label: string;
  readonly observationId: string;
  readonly role: string;
  readonly target: string;
}

export const attachedElement = (
  observation: AndroidWorkspaceObservation,
  node: ObservedNode
): AttachedElement => ({
  box: elementBox(observation, node),
  label: elementLabel(node),
  observationId: observation.id,
  role: node.role,
  target: node.target,
});

/**
 * The element a comment can name under a point of the screen, given as
 * fractions of its size: the smallest listed field or control there, else the
 * smallest named element. A control's own label is often a smaller text node
 * with the same name, and a click means the control. A bare container names
 * nothing.
 */
export const elementAt = (
  observation: AndroidWorkspaceObservation,
  x: number,
  y: number
): ObservedNode | undefined => {
  const px = x * observation.width;
  const py = y * observation.height;
  let hit: ObservedNode | undefined;
  let area = Infinity;
  let control = false;
  for (const node of listedNodes(observation)) {
    const { bounds } = node;
    if (
      bounds === undefined ||
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      (!node.editable && node.name.trim() === "") ||
      px < bounds.x ||
      py < bounds.y ||
      px > bounds.x + bounds.width ||
      py > bounds.y + bounds.height
    ) {
      continue;
    }
    const size = bounds.width * bounds.height;
    const isControl = elementGroup(node) !== "other";
    if ((isControl && !control) || (isControl === control && size < area)) {
      hit = node;
      area = size;
      control = isControl;
    }
  }
  return hit;
};

/** A comment's numbered pin on the screen, where its element sits now. */
export interface CommentPin {
  readonly box: ScreenBox;
  /** The comment's number on the recording, counting from 1. */
  readonly index: number;
}

/** How far a box may move, in fractions of the screen, and still be the same element. */
const PIN_TOLERANCE = 0.01;

const sameBox = (a: ScreenBox, b: ScreenBox) =>
  Math.abs(a.left - b.left) <= PIN_TOLERANCE &&
  Math.abs(a.top - b.top) <= PIN_TOLERANCE &&
  Math.abs(a.width - b.width) <= PIN_TOLERANCE &&
  Math.abs(a.height - b.height) <= PIN_TOLERANCE;

/**
 * The pins of the comments whose element is on this screen: the observation
 * holds a node with the element's role and name where it was picked. A screen
 * that moved on, or scrolled the element away, shows no pin for it.
 */
export const commentPins = (
  observation: AndroidWorkspaceObservation | null,
  instructions: readonly NativeTeachingInstruction[]
): readonly CommentPin[] => {
  if (observation === null) {
    return [];
  }
  return instructions.flatMap((instruction, position) => {
    const box = instruction.element?.box;
    if (instruction.element === undefined || box === undefined) {
      return [];
    }
    const { name, role } = instruction.element;
    const onScreen = observation.nodes.some((node) => {
      if (node.role !== role || node.name !== name) {
        return false;
      }
      const nodeBox = elementBox(observation, node);
      return nodeBox !== undefined && sameBox(nodeBox, box);
    });
    return onScreen ? [{ box, index: position + 1 }] : [];
  });
};
