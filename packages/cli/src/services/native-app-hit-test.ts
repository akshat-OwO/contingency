/** Shared Workspace pick resolution for native runtimes. */
interface HitTarget {
  readonly name: string;
  readonly editable: boolean;
  readonly hittable: boolean;
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** The smallest named actionable node under a Workspace point. */
export const nativeHitTest = <Node extends HitTarget>(
  nodes: readonly Node[],
  x: number,
  y: number
): Node | undefined => {
  let hit: Node | undefined;
  let area = Infinity;
  for (const node of nodes) {
    const { bounds } = node;
    // An unnamed hittable node, such as a scroll container, has no semantic
    // identity to teach or replay, so a click there activates nothing.
    if (
      !(node.editable || (node.hittable && node.name.trim() !== "")) ||
      bounds === undefined ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      continue;
    }
    if (
      x < bounds.x ||
      y < bounds.y ||
      x > bounds.x + bounds.width ||
      y > bounds.y + bounds.height
    ) {
      continue;
    }
    const size = bounds.width * bounds.height;
    if (size < area) {
      hit = node;
      area = size;
    }
  }
  return hit;
};
