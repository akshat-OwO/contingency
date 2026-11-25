import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { jsPluginSettings, selectJsPlugins } from "ultracite/oxlint/js-plugins";
import tanstack from "ultracite/oxlint/tanstack";
import tanstackJsPlugins from "ultracite/oxlint/tanstack/js-plugins";

const jsPlugins = selectJsPlugins(["react-doctor"]);

const uiSdkAdr = "docs/adr/0086-workspace-ui-is-built-on-ui-sdk.md";

// Libraries UI SDK replaces. Nothing in the repo may import them.
const replacedUiLibraries = [
  "@base-ui/react",
  "@shadcn/react",
  "shadcn",
  "cmdk",
  "vaul",
  "sonner",
  "react-resizable-panels",
  "embla-carousel-react",
  "react-day-picker",
  "input-otp",
];

const replacedUiImports = replacedUiLibraries.map((name) => ({
  group: [name, `${name}/**`],
  message: `UI SDK replaces ${name}. Import from @/components/ui/* instead. See ${uiSdkAdr}.`,
}));

const restrictedUiImports = ({ allowUiSdkTesting = false } = {}) => [
  ...replacedUiImports,
  {
    group: [
      "@ui-sdk/**",
      ...(allowUiSdkTesting ? ["!@ui-sdk/core/testing"] : []),
    ],
    message: `Import UI SDK only in apps/web/src/components/ui/. Use the @/components/ui/* facade. See ${uiSdkAdr}.`,
  },
];

const restrictedTimerImports = [
  "node:timers",
  "node:timers/promises",
  "timers",
  "timers/promises",
].map((name) => ({
  allowTypeImports: true,
  importNames: ["default", "scheduler", "setInterval", "setTimeout"],
  message:
    "Wait on events or TestClock, not real time. See docs/agents/testing.md.",
  name,
}));

export default defineConfig({
  extends: [core, tanstack, tanstackJsPlugins, antiSlop, jsPlugins],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    // Throwaway design prototypes are not production source.
    "docs/prototypes/**",
    "apps/web/src/routeTree.gen.ts",
  ],
  jsPlugins: [
    ...jsPlugins.jsPlugins,
    {
      name: "contingency",
      specifier: "./packages/lint-rules/src/index.mjs",
    },
  ],
  overrides: [
    {
      files: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "apps/*/src/test/**",
        "**/tests/**",
      ],
      rules: {
        "contingency/no-test-wait": "error",
        "no-restricted-imports": [
          "error",
          {
            paths: restrictedTimerImports,
            patterns: restrictedUiImports({ allowUiSdkTesting: true }),
          },
        ],
      },
    },
    {
      // The CLI writes the Diagnostic Log, so it never drops a failure unlogged.
      files: ["packages/cli/src/**"],
      rules: { "contingency/no-silent-ignore": "error" },
    },
    {
      // The facade is the one place that builds on UI SDK.
      files: ["apps/web/src/components/ui/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: replacedUiImports }],
      },
    },
    {
      files: [
        "packages/cli/src/services/diagnostic-log.ts",
        "packages/cli/src/services/recorder-events.ts",
        "packages/cli/src/services/run-footage.ts",
        "packages/cli/tests/integration/scripted-agent.ts",
        "packages/cli/tests/integration/transcript.ts",
        "packages/protocol/src/agent-browser.ts",
        "packages/protocol/src/agent-decision.ts",
        "packages/protocol/src/agent-pursuit.ts",
        "packages/protocol/src/agent-identifiers.ts",
        "packages/protocol/src/agent-run.ts",
        "packages/protocol/src/agent-session.ts",
        "packages/protocol/src/agent-session-compact.ts",
        "packages/protocol/src/teaching-recording.ts",
        "packages/protocol/src/browser-checks.ts",
        "packages/protocol/src/browser-modifications.ts",
        "packages/protocol/src/browser-identifiers.ts",
        "packages/protocol/src/browser-identity.ts",
        "packages/protocol/src/browser-rpc-error.ts",
        "packages/protocol/src/emulation.ts",
        "packages/protocol/src/failure-reference.ts",
        "packages/protocol/src/flow.ts",
        "packages/protocol/src/index.ts",
        "packages/protocol/src/platform.ts",
        "packages/protocol/src/run.ts",
        "packages/protocol/src/run-video.ts",
        "packages/protocol/src/scans.ts",
        "packages/protocol/src/storage.ts",
        "packages/protocol/src/viewport.ts",
      ],
      rules: {
        // Oxlint's rule does not distinguish TypeScript's value/type namespaces.
        "no-redeclare": "off",
      },
    },
  ],
  rules: {
    "contingency/fixed-log-message": "error",
    "no-restricted-imports": ["error", { patterns: restrictedUiImports() }],
  },
  settings: jsPluginSettings,
});
