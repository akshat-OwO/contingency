import type { NativeElementPick } from "./android-device";
import type { AttachedElement } from "./screen-elements";

/** A native Teaching comment while it is written. */
export interface NativeComment {
  readonly attached: AttachedElement | null;
  readonly open: boolean;
  readonly picking: boolean;
  /** It was sent and has not answered; it closes once it saves. */
  readonly submitting: boolean;
}
export const closedComment: NativeComment = {
  attached: null,
  open: false,
  picking: false,
  submitting: false,
};

/** The open comment's pick on the device stage. */
export const commentPick = (
  comment: NativeComment,
  setComment: (update: (current: NativeComment) => NativeComment) => void
): NativeElementPick | undefined =>
  comment.open
    ? {
        attached: comment.attached ?? undefined,
        onCancel: () =>
          setComment((current) => ({ ...current, picking: false })),
        onPick: (element) =>
          setComment((current) => ({
            ...current,
            attached: element,
            picking: false,
          })),
        picking: comment.picking,
      }
    : undefined;
