import { Schema } from "effect";

// oxlint-disable-next-line eslint/no-redeclare
export const TeachingRecordingId = Schema.String.check(
  Schema.isPattern(/^recording-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
).pipe(Schema.brand("@contingency/TeachingRecordingId"));
// oxlint-disable-next-line eslint/no-redeclare
export type TeachingRecordingId = typeof TeachingRecordingId.Type;
