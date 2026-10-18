import { FlowSkillName } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { readFlowSkillFrontmatter } from "../../src/services/flow-skill-package.ts";
import {
  startingRunEmulation,
  skillRunEmulation,
} from "../../src/services/run-emulation.ts";

const skill = (name: string, block: string) => ({
  emulation: readFlowSkillFrontmatter(
    `---\nname: ${name}\n${block}\n---\nprocedure\n`
  )?.emulation,
  name: FlowSkillName.make(name),
});

it.effect(
  "uses the declared environment even when the first legacy skill has none",
  () =>
    Effect.gen(function* chooseSaved() {
      const selected = yield* startingRunEmulation([
        skill("legacy", ""),
        skill(
          "phone",
          "emulation:\n  viewport: 390x844@2\n  userAgentProfile: chrome-android-mobile\n  locale: en-IN"
        ),
      ]);
      expect(selected.source).toBe("phone");
      expect(selected.emulation).toMatchObject({
        locale: "en-IN",
        userAgentProfile: "chrome-android-mobile",
        viewport: { deviceScaleFactor: 2, height: 844, width: 390 },
      });
    })
);

it.effect(
  "refuses malformed requirements instead of silently falling back",
  () =>
    Effect.gen(function* rejectInvalid() {
      for (const declaration of [
        "",
        "  locale: en-IN",
        "  viewport: wide",
        "  viewport: 390x844@1\n  userAgentProfile: retired-profile",
        "  viewport: 390x844@1\n  geolocation: 128,77",
        "  viewport: 390x844@1\n  colorScheme: ultraviolet",
        "  viewport: 390x844@1\n  timezone: Not/AZone",
        "  viewport: 390x844@1\n  locale: invalid_locale",
        "  viewport: 390x844@1\n  viewport: 800x600@1",
        "  viewport: 390x844@1\n  unknownDevice: phone",
        "  viewport: 390x844@1\n  permissions:\n    - geolocation granted\n    - geolocation denied",
        "  viewport: 390x844@1\n  permissions:\n    - {invalid}",
      ]) {
        const error = yield* Effect.flip(
          skillRunEmulation(skill("invalid", `emulation:\n${declaration}`))
        );
        expect(error.code).toBe("flow_skill_invalid");
        expect(error.message).toContain("invalid emulation");
      }
    })
);

it.effect(
  "rejects conflicting starting skills and ignores permission list order",
  () =>
    Effect.gen(function* requireOneEnvironment() {
      const base = "emulation:\n  viewport: 390x844@1\n  permissions:\n";
      const same = yield* startingRunEmulation([
        skill(
          "one",
          `${base}    - geolocation granted\n    - notifications denied`
        ),
        skill(
          "two",
          `${base}    - notifications denied\n    - geolocation granted`
        ),
      ]);
      expect(same.source).toBe("one");
      const conflict = yield* Effect.flip(
        startingRunEmulation([
          skill("one", "emulation:\n  viewport: 390x844@1"),
          skill("two", "emulation:\n  viewport: 1280x800@1"),
        ])
      );
      expect(conflict.message).toContain("viewport");
      expect(conflict.message).toContain("separate Runs");
    })
);

it.effect(
  "validates scale ranges and compares saved percentages with legacy defaults",
  () =>
    Effect.gen(function* validateScale() {
      const base = "emulation:\n  viewport: 1280x800@1";
      const selected = yield* startingRunEmulation([
        skill("scaled", `${base}\n  pageZoom: 400\n  textScale: 200`),
      ]);
      expect(selected.emulation).toMatchObject({
        pageZoom: 400,
        textScale: 200,
      });
      expect(
        (yield* startingRunEmulation([
          skill("legacy", base),
          skill("explicit", `${base}\n  pageZoom: 100\n  textScale: 100`),
        ])).source
      ).toBe("legacy");
      for (const declaration of [
        "pageZoom: 24",
        "pageZoom: 501",
        "pageZoom: invalid",
        "textScale: 49",
        "textScale: 301",
        "textScale: NaN",
      ]) {
        expect(
          yield* Effect.flip(
            skillRunEmulation(skill("invalid", `${base}\n  ${declaration}`))
          )
        ).toHaveProperty("code", "flow_skill_invalid");
      }
      expect(
        (yield* Effect.flip(
          startingRunEmulation([
            skill("base", base),
            skill("scaled", `${base}\n  textScale: 200`),
          ])
        )).message
      ).toContain("textScale");
    })
);
