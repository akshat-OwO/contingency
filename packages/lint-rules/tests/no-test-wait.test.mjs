import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import plugin from "../src/index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules["no-test-wait"];
const wait = (code) => ({ code, errors: [{ messageId: "wait" }] });

new RuleTester().run("no-test-wait", rule, {
  invalid: [
    wait('Effect.sleep("1 second");'),
    wait("Effect.succeed(1).pipe(Effect.delay(30));"),
    wait('Schedule.spaced("50 millis");'),
    wait('Schedule.exponential("10 millis");'),
    wait("setTimeout(() => {}, 1);"),
    wait("globalThis.setInterval(() => {}, 1);"),
    wait("page.waitForTimeout(5);"),
    wait('import { setTimeout as delay } from "node:timers/promises";'),
    wait('import { setTimeout as delay } from "node:timers";'),
    wait('import { setInterval } from "timers";'),
    wait('import { scheduler } from "timers/promises";'),
    wait('import * as timers from "node:timers/promises";'),
  ],
  valid: [
    'import { setImmediate } from "node:timers/promises";',
    'import { setImmediate } from "node:timers";',
    "page.evaluate(() => { setTimeout(() => {}, 1); });",
    "page.addInitScript(function init() { setInterval(() => {}, 1); });",
    'TestClock.adjust("1 second");',
    'Effect.timeout(work, "30 seconds");',
  ],
});
