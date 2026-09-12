import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackJsPlugins from "ultracite/oxlint/tanstack/js-plugins";

const jsPlugins = selectJsPlugins(["react-doctor"]);

export default defineConfig({
  extends: [core, tanstack, tanstackJsPlugins, antiSlop, jsPlugins],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "apps/web/src/components/ui/**",
    "apps/web/src/routeTree.gen.ts",
  ],
  jsPlugins: jsPlugins.jsPlugins,
  overrides: [
    {
      files: [
        "packages/cli/src/services/agent-flow-catalog.ts",
        "packages/cli/src/services/recorder-events.ts",
        "packages/protocol/src/agent-browser.ts",
        "packages/protocol/src/agent-flow.ts",
        "packages/protocol/src/agent-identifiers.ts",
        "packages/protocol/src/agent-run.ts",
        "packages/protocol/src/agent-session.ts",
        "packages/protocol/src/browser-identifiers.ts",
        "packages/protocol/src/browser-identity.ts",
        "packages/protocol/src/browser-rpc-error.ts",
        "packages/protocol/src/emulation.ts",
        "packages/protocol/src/flow.ts",
        "packages/protocol/src/index.ts",
        "packages/protocol/src/run.ts",
        "packages/protocol/src/storage.ts",
        "packages/protocol/src/viewport.ts",
      ],
      rules: {
        // Oxlint's rule does not distinguish TypeScript's value/type namespaces.
        "no-redeclare": "off",
      },
    },
  ],
  settings: jsPluginSettings,
});
