import { useAtom } from "@effect/atom-react";

import { approachStateAtom } from "./model";
import type { ApproachId, PrototypeState } from "./model";

/** One approach's prototype state and a functional updater for it. */
export const useApproach = (approach: ApproachId) => {
  const [state, setState] = useAtom(approachStateAtom(approach));
  const update = (change: (current: PrototypeState) => PrototypeState) =>
    setState(change);
  return [state, update] as const;
};
