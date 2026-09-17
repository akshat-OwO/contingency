import { Cause } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";

/**
 * The message behind a failed RPC, for the one line the Workspace shows the
 * user. A refusal is always something the user can act on, so it is rendered
 * as text rather than swallowed.
 */
export const refusal = (
  result: AsyncResult.AsyncResult<unknown, unknown> | undefined
): string | undefined => {
  if (result === undefined || !AsyncResult.isFailure(result)) {
    return undefined;
  }
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : String(error);
};
