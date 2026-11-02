import { Schema } from "effect";

// oxlint-disable-next-line eslint/no-redeclare
export const FlowName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/u)
).pipe(Schema.brand("@contingency/FlowName"));
// The schema value and its inferred type intentionally share the public name.
// oxlint-disable-next-line eslint/no-redeclare
export type FlowName = typeof FlowName.Type;
