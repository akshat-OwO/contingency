import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { iosEnabledAtom } from "@/lib/rpc";

/** Whether this process offers iOS sessions at all. */
export const useIosEntryEnabled = () => {
  const enabled = useAtomValue(iosEnabledAtom);
  return AsyncResult.isSuccess(enabled) && enabled.value;
};
