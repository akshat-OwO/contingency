import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "../src/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules["no-silent-ignore"];
const silent = (code) => ({ code, errors: [{ messageId: "silent" }] });

new RuleTester().run("no-silent-ignore", rule, {
  invalid: [
    silent("effect.pipe(Effect.ignore);"),
    silent("Effect.ignore(effect);"),
    silent("effect.pipe(Effect.ignoreCause);"),
    silent("effect.pipe(Effect.ignore({ log: false, message: 'Dropped' }));"),
    silent("effect.pipe(Effect.ignore({ log: 'Debug' }));"),
    silent("effect.pipe(Effect.ignore({ log: 'Debug', message: reason }));"),
    // oxlint-disable-next-line no-template-curly-in-string -- the rule's input is source text.
    silent("Effect.ignore(effect, { log: true, message: `Lost ${file}` });"),
    silent('import { Effect as E } from "effect"; effect.pipe(E.ignore);'),
    silent('import * as E from "effect/Effect"; effect.pipe(E.ignore);'),
    silent('import { ignore } from "effect/Effect"; effect.pipe(ignore);'),
  ],
  valid: [
    'effect.pipe(Effect.ignore({ log: "Debug", message: "Lock was gone" }));',
    'Effect.ignore(effect, { log: true, message: "Lock was gone" });',
    'effect.pipe(Effect.ignoreCause({ log: "Warn", message: "Lost" }));',
    'import { ignore } from "effect/Effect"; effect.pipe(ignore({ log: "Debug", message: "Lost" }));',
    "Stream.ignore(stream);",
    "list.ignore;",
  ],
});
