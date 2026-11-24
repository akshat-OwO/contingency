import { RpcMiddleware } from "effect/rpc";

import { BrowserRpcError } from "./browser-rpc-error.ts";

/**
 * Turns a handler's defect into an `internal_failure` with a Failure
 * Reference, so one failed request never fails the client's other requests.
 */
export class RpcFailures extends RpcMiddleware.Service<RpcFailures>()(
  "contingency/RpcFailures",
  { error: BrowserRpcError }
) {}
