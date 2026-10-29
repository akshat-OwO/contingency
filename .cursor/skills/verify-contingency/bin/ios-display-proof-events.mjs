/* oxlint-disable eslint/no-await-in-loop -- Each journal event triggers one state read. */
/** Check the state after each journal event without waiting past the matched stage. */
export const awaitProofStage = async (changes, readStage) => {
  try {
    const initial = await readStage();
    if (initial) {
      return initial;
    }
    for await (const _change of changes) {
      const found = await readStage();
      if (found) {
        return found;
      }
    }
    return null;
  } finally {
    await changes.return();
  }
};

export const proofCaptureStage = (requests, fill) =>
  requests.find(
    (entry) =>
      entry.start > fill.end &&
      entry.command === "screenshot" &&
      entry.end === null
  );
