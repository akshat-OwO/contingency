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
    wait("page.evaluate(() => { setTimeout(() => {}, 1); });"),
    wait("page.addInitScript(function init() { setInterval(() => {}, 1); });"),
    wait(
      "await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));"
    ),
    wait("globalThis.setInterval(() => {}, 1);"),
    wait("page.waitForTimeout(5);"),
    wait("sleep(20);"),
    wait("delayMs(20);"),
    wait("Bun.sleep(20);"),
    wait("page['waitForTimeout'](20);"),
    wait("window.setTimeout(() => {}, 20);"),
    wait("while (!ready) { await sleepFor(20); }"),
    wait('import { Effect as E } from "effect"; E.sleep(20);'),
    wait('import * as E from "effect/Effect"; E.delay(20);'),
    wait('import { sleep as snooze } from "effect/Effect"; snooze(20);'),
    wait('import { Schedule as S } from "effect"; S.spaced(20);'),
    wait('import { spaced as poll } from "effect/Schedule"; poll(20);'),
    wait('import { sleep as snooze } from "./helpers"; snooze(20);'),
  ],
  valid: [
    'import { setImmediate } from "node:timers/promises";',
    'import { setImmediate } from "node:timers";',
    'TestClock.adjust("1 second");',
    'Effect.timeout(work, "30 seconds");',
  ],
});
