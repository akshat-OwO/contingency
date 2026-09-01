import { Schema } from "effect";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * An Agent Session is a coordination envelope, not a browser session or a
 * durable Run. Keeping its identifier separate prevents a URL selector from
 * accidentally becoming a handle to the lower-level browser API.
 */
const agentSessionIdPattern = /^agent-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const AgentSessionId = Schema.String.check(
  Schema.isPattern(agentSessionIdPattern)
).pipe(Schema.brand("@contingency/AgentSessionId"));
export type AgentSessionId = typeof AgentSessionId.Type;

/** A process ownership marker used to scope Agent View discovery. */
export const AgentProcessId = nonEmptyString.pipe(
  Schema.brand("@contingency/AgentProcessId")
);
export type AgentProcessId = typeof AgentProcessId.Type;

/** A retry-safe id supplied by the external agent on every mutation. */
export const OperationId = nonEmptyString.pipe(
  Schema.brand("@contingency/OperationId")
);
export type OperationId = typeof OperationId.Type;

/** Who holds the browser. Control is exclusive, never shared. */
export const AgentSessionController = Schema.Literals(["agent", "user"]);
export type AgentSessionController = typeof AgentSessionController.Type;
