import type {
  AndroidWorkspaceObservation,
  NativeInput,
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
