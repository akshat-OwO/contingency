/**
 * A panel's share of the room in percent, for a size kept in pixels. Before
 * the room is measured, there's no share to give.
 */
export const pixelShare = (size: number, room: number): number =>
  room > 0 ? Math.min(Math.max((size / room) * 100, 0), 100) : 0;

/** A panel's size in pixels, for its share of the room in percent. */
export const shareSize = (share: number, room: number): number =>
  Math.round((share / 100) * room);
