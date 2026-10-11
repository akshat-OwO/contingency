import { Data } from "effect";

/** Why `contingency start` could not choose or launch an Agent Harness. */
export class AgentLaunchError extends Data.TaggedError("AgentLaunchError")<{
  readonly message: string;
}> {}
