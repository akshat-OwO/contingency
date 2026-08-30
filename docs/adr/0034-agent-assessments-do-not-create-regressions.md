# Agent Assessments do not create Regressions

**Agent Assessments** and their evidence remain in Run history, but the first version does not turn changes in model judgment into automatic **Regressions** or **Alerts**. Agent View may show prior assessment counts and evidence for a user to compare. Deterministic Audits and Gates retain their existing Regression and alert semantics.

Treating `working` and `not-working` as deterministic results was rejected because assessments may change with the model, provider, context, or observation even when the website does not. Automatic alerts would therefore confuse model variance with product regressions.
