import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";

import { SETTINGS_SCHEMA_FILE } from "../services/settings.ts";
import {
  renderSettingsJsonSchema,
  renderSettingsReference,
  SETTINGS_REFERENCE_FILE,
} from "./settings-documents.ts";

Effect.gen(function* generateSettings() {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.writeFileString(
    path.resolve(SETTINGS_SCHEMA_FILE),
    renderSettingsJsonSchema()
  );
  yield* fileSystem.writeFileString(
    path.resolve(SETTINGS_REFERENCE_FILE),
    renderSettingsReference()
  );
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
