import type {
  NativeInstructionElement,
  TeachingNativeElement,
} from "@contingency/protocol";

interface ElementNode {
  readonly target: string;
  readonly role: string;
  readonly name: string;
  readonly editable: boolean;
  readonly covered: boolean;
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
 * place. A comment never names an element the user can no longer see.
 */
export const resolveInstructionElement = <Node extends ElementNode>(input: {
  readonly element: NativeInstructionElement;
  readonly retained: readonly RetainedObservation<Node>[];
  readonly latest: RetainedObservation<Node> | null;
  /** Inputs sent since the latest observation began. */
  readonly unobserved: number;
  readonly platform: TeachingNativeElement["platform"];
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
        sameBounds(node.bounds, attached.bounds)
    )
  ) {
    return undefined;
  }
  const resolved: TeachingNativeElement = {
    context: [input.appId],
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
