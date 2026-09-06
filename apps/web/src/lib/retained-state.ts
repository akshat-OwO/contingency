import { Atom } from "effect/unstable/reactivity";

/**
 * How many keys one retained family holds. A review the user has left behind
 * keeps its corrections for as long as they might come back to it, and the
 * oldest is dropped once that many are held, so the family never grows without
 * bound.
 */
const RETAINED_KEYS = 16;

/**
 * State the user has entered, held apart from the region that shows it.
 *
 * Agent View's sidebar renders each region behind a gate on the session
 * snapshot, and a snapshot that omits a region's data for one update unmounts
 * that region. An ordinary `Atom.make` is idle-collected once its last
 * subscriber goes, so a region that leaves the screen for longer than the
 * registry's idle window comes back rebuilt from its initial value — which is
 * what silently discarded a half-typed correction.
 *
 * Every key's value therefore lives in one kept-alive store, and the atom a
 * component subscribes to is a view onto it. The view may be collected as
 * often as the registry likes: reading it again re-derives the value the user
 * left there.
 */
export const retainedFamily = <A>(
  initial: A,
  limit: number = RETAINED_KEYS
): ((key: string) => Atom.Writable<A, A>) => {
  const store = Atom.keepAlive(Atom.make<ReadonlyMap<string, A>>(new Map()));
  return Atom.family((key: string) =>
    Atom.writable<A, A>(
      (get) => {
        const held = get(store);
        return held.has(key) ? (held.get(key) as A) : initial;
      },
      (ctx, value) => {
        const next = new Map(ctx.get(store));
        // Reinserting makes this key the most recently used, so the key that
        // is dropped is always the one no review has touched for longest.
        next.delete(key);
        next.set(key, value);
        while (next.size > limit) {
          const oldest = next.keys().next();
          if (oldest.done === true) {
            break;
          }
          next.delete(oldest.value);
        }
        ctx.set(store, next);
      }
    )
  );
};
