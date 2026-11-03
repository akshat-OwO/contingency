import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

const catalogDirectory = async (catalog, kind, id) => {
  const entries = await readdir(catalog, { recursive: true });
  const match = entries.find(
    (entry) => entry.split(path.sep).slice(-2).join("/") === `${kind}/${id}`
  );
  assert.ok(match, `${kind}/${id} is stored in the catalog`);
  return path.join(catalog, match);
};

/** ADR 0071: a Run lives under its one Flow's runs/, otherwise the root runs/. */
export const runDirectory = (catalog, runId) =>
  catalogDirectory(catalog, "runs", runId);

/** ADR 0071: a Recording lives under its Flow's recordings/. */
export const recordingDirectory = (catalog, recordingId) =>
  catalogDirectory(catalog, "recordings", recordingId);
