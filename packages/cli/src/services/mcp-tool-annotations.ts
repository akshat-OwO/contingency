import { Tool } from "effect/ai";

/**
 * Marks a tool that only reads. Hosts use these MCP hints to approve reads
 * or run them concurrently; an unannotated tool is advertised as destructive
 * and open-world.
 */
export const readOnly = <T extends Tool.Any>(tool: T): T =>
  // SAFETY: `annotate` returns the same tool with one more annotation; it
  // does not change the tool's name, schemas, or handler requirements.
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false) as T;
