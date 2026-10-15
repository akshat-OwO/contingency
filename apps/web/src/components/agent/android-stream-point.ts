/** A click on the display, as fractions of the decoded frame. */
export interface AndroidStreamPoint {
  readonly x: number;
  readonly y: number;
}

export interface AndroidStreamFrame {
  readonly height: number;
  readonly width: number;
}

/**
 * Where a click landed on the displayed frame, as fractions of its size. The
 * frame fills its box exactly, so the box is the frame.
 */
export const framePoint = (
  click: { readonly clientX: number; readonly clientY: number },
  box: {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  }
): AndroidStreamPoint | null =>
  box.width <= 0 || box.height <= 0
    ? null
    : {
        x: Math.min(Math.max((click.clientX - box.left) / box.width, 0), 1),
        y: Math.min(Math.max((click.clientY - box.top) / box.height, 0), 1),
      };
