import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "@effect/vitest";

import {
  renderSettingsJsonSchema,
  renderSettingsReference,
  SETTINGS_REFERENCE_FILE,
} from "../../src/packaging/settings-documents.ts";
import {
  ENVIRONMENT_ONLY_SETTINGS,
  SETTING_ENV_BY_KEY,
  SETTINGS_SCHEMA_FILE,
} from "../../src/services/settings.ts";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const committed = (file: string) =>
  readFileSync(path.join(packageRoot, file), "utf-8");

const REGENERATE =
  "Run `nub src/packaging/generate-settings.ts` in packages/cli.";

it("keeps the committed JSON Schema current", () => {
  expect(committed(SETTINGS_SCHEMA_FILE), REGENERATE).toBe(
    renderSettingsJsonSchema()
  );
});

it("keeps the committed Settings reference current", () => {
  expect(committed(SETTINGS_REFERENCE_FILE), REGENERATE).toBe(
    renderSettingsReference()
  );
});

interface Node {
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Node>>;
}

/** Every node has a description, and every object refuses unknown keys. */
const visit = (node: Node, pointer: string) => {
  expect(node.description, pointer).toBeTruthy();
  if (node.properties !== undefined) {
    expect(node.additionalProperties, pointer).toBe(false);
    for (const [key, child] of Object.entries(node.properties)) {
      visit(child, `${pointer}/${key}`);
    }
  }
};

it("describes every field and refuses unknown keys at every level", () => {
  // SAFETY: the file is the schema this package renders.
  visit(JSON.parse(renderSettingsJsonSchema()) as Node, "");
});

it("names every Setting's environment variable in the reference", () => {
  const reference = renderSettingsReference();
  for (const env of SETTING_ENV_BY_KEY.values()) {
    expect(reference).toContain(`\`${env}\``);
  }
  for (const { env } of ENVIRONMENT_ONLY_SETTINGS) {
    expect(reference).toContain(`\`${env}\``);
  }
});
