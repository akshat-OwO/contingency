// Per-cell statistics of the #461 matrix, shared by aggregate.mjs and check.mjs.
const median = (values) => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const spread = (values) =>
  values.length
    ? {
        max: Math.max(...values),
        median: median(values),
        min: Math.min(...values),
      }
    : null;

export const cell = (list) => {
  const measured = list.filter((run) => !run.usage?.missing);
  // A run whose choices need review has unknown counts, not zero.
  const unresolved = list.filter((run) => run.classificationValid === false);
  const rule = (number) =>
    list.reduce((sum, run) => sum + (run.byRule?.[number] ?? 0), 0);
  return {
    completed: list.filter((run) => run.completion).length,
    incorrect: { 1: rule(1), 2: rule(2), 3: rule(3), 4: rule(4) },
    input: spread(measured.map((run) => run.usage.input)),
    output: spread(measured.map((run) => run.usage.output)),
    payloadBytes: spread(list.map((run) => run.payloadBytes)),
    peak: spread(measured.map((run) => run.usage.peak)),
    runIds: list.map((run) => run.runId),
    runs: list.length,
    unresolvedClassifications: unresolved.map((run) => run.runId),
    usageMissing: list.length - measured.length,
    wallMs: spread(list.map((run) => run.wallMs)),
  };
};
