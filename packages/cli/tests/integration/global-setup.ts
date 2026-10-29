import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    integrationRoot: string;
  }
}

export default function setup(project: TestProject) {
  const root = mkdtempSync(
    path.join(tmpdir(), "contingency-integration-suite-")
  );
  project.provide("integrationRoot", root);
  // Chromium can still write its profile after a file's afterAll. Remove
  // temporary files only after the worker pool closes. Global teardown runs
  // earlier, while workers can still recreate directories.
  project.vitest.onClose(() => {
    rmSync(root, { force: true, recursive: true });
  });
}
