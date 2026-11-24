import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "../src/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules["fixed-log-message"];
const changing = (code) => ({ code, errors: [{ messageId: "message" }] });

new RuleTester().run("fixed-log-message", rule, {
  invalid: [
    // oxlint-disable-next-line no-template-curly-in-string -- the rule's input is source text.
    changing("Effect.logWarning(`Run footage stopped: ${cause.message}`);"),
    changing('Effect.logError("Could not save " + file);'),
    changing("Effect.logDebug(error.message);"),
    changing("Effect.logError(cause);"),
    changing("Effect.log(String(error));"),
    changing('import { Effect as E } from "effect"; E.logInfo(label);'),
    changing('import * as E from "effect/Effect"; E.logWarning(reason);'),
    changing(
      'import { logWarning as warn } from "effect/Effect"; warn(reason);'
    ),
  ],
  valid: [
    'Effect.logWarning("Run footage stopped", { error });',
    "Effect.logDebug(`Dropped a frame while the encoder was busy.`);",
    'Effect.logError("MCP tool failed", cause);',
    "console.log(message);",
    "logger.log(message);",
  ],
});
