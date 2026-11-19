import { nativeTeachingInstructionLimit } from "@contingency/protocol";
import type {
  NativeInstructionElement,
  NativeTeachingInstruction,
  TeachingNativeElement,
} from "@contingency/protocol";

interface ElementNode {
  readonly target: string;
  readonly role: string;
  readonly name: string;
  readonly editable: boolean;
  readonly covered: boolean;
  /** The app that owns the node, when the observer could name it. */
  readonly packageName?: string | null;
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface RetainedObservation<Node extends ElementNode> {
  readonly id: string;
  readonly nodes: readonly Node[];
}

const sameBounds = (
  left: ElementNode["bounds"],
  right: ElementNode["bounds"]
) =>
  left === undefined || right === undefined
    ? left === right
    : left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height;

/**
 * Resolves the element a native Teaching comment is attached to, or nothing
 * when it is no longer on the screen. The element must come from an
 * observation the session still retains, and the latest observation, with no
 * Forwarded Input since it began, must still show it uncovered in the same
 * place and owned by the same app. A comment never names an element the user
 * can no longer see, nor another app's control that looks the same.
 */
export const resolveInstructionElement = <Node extends ElementNode>(input: {
  readonly element: NativeInstructionElement;
  readonly retained: readonly RetainedObservation<Node>[];
  readonly latest: RetainedObservation<Node> | null;
  /** Inputs sent since the latest observation began. */
  readonly unobserved: number;
  readonly platform: TeachingNativeElement["platform"];
  /** The app to name when the picked node does not say which owns it. */
  readonly appId: string;
}): TeachingNativeElement | undefined => {
  const { element, latest } = input;
  const attached = input.retained
    .find((observation) => observation.id === element.observationId)
    ?.nodes.find((node) => node.target === element.target);
  if (
    attached === undefined ||
    attached.covered ||
    attached.role.trim() === "" ||
    latest === null ||
    input.unobserved > 0 ||
    !latest.nodes.some(
      (node) =>
        !node.covered &&
        node.role === attached.role &&
        node.name === attached.name &&
        (node.packageName ?? null) === (attached.packageName ?? null) &&
        sameBounds(node.bounds, attached.bounds)
    )
  ) {
    return undefined;
  }
  const resolved: TeachingNativeElement = {
    context: [attached.packageName ?? input.appId],
    editable: attached.editable,
    name: attached.name,
    observationId: element.observationId,
    platform: input.platform,
    role: attached.role,
  };
  const { bounds } = attached;
  return bounds === undefined
    ? resolved
    : {
        ...resolved,
        bounds: {
          height: bounds.height,
          width: bounds.width,
          x: bounds.x,
          y: bounds.y,
        },
      };
};

/** The element as one phrase, the form a web comment's `target` takes. */
export const instructionElementLabel = (element: TeachingNativeElement) =>
  element.name.trim() === ""
    ? element.role
    : `${element.role} "${element.name.trim()}"`;

export const staleInstructionElement =
  "The attached element is no longer on the screen. Attach it again; the comment was not saved.";

const unit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Where an element sits on the screen it was picked from, in fractions of
 * that screen, clipped to it: the convention the Workspace draws boxes in.
 * Null when the element has no bounds, the screen has no size, or the
 * element lies wholly off it.
 */
export const instructionElementBox = (
  bounds: TeachingNativeElement["bounds"],
  screen: { readonly width: number; readonly height: number } | undefined
) => {
  if (
    bounds === undefined ||
    screen === undefined ||
    !(screen.width > 0) ||
    !(screen.height > 0)
  ) {
    return null;
  }
  const left = unit(bounds.x / screen.width);
  const top = unit(bounds.y / screen.height);
  const right = unit((bounds.x + bounds.width) / screen.width);
  const bottom = unit((bounds.y + bounds.height) / screen.height);
  return right <= left || bottom <= top
    ? null
    : { height: bottom - top, left, top, width: right - left };
};

/**
 * One recorded comment as a native workspace summary lists it, with its
 * attached element placed on the screen it was picked from.
 */
export const listedInstruction = (input: {
  readonly id: string;
  readonly at: string;
  readonly text: string;
  readonly target: string | null;
  readonly element: TeachingNativeElement | undefined;
  readonly screen:
    | { readonly width: number; readonly height: number }
    | undefined;
}): NativeTeachingInstruction => {
  const listed = {
    at: input.at,
    id: input.id,
    // A summary's text fields stay within the protocol's bound.
    target: input.target === null ? null : input.target.slice(0, 4096),
    text: input.text,
  };
  if (input.element === undefined) {
    return listed;
  }
  const box = instructionElementBox(input.element.bounds, input.screen);
  const element = { name: input.element.name, role: input.element.role };
  return {
    ...listed,
    element: box === null ? element : { ...element, box },
  };
};

/** Appends a comment, keeping only the latest ones a summary may carry. */
export const appendInstruction = (
  listed: readonly NativeTeachingInstruction[] | undefined,
  instruction: NativeTeachingInstruction
): readonly NativeTeachingInstruction[] =>
  [...(listed ?? []), instruction].slice(-nativeTeachingInstructionLimit);
