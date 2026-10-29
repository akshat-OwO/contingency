import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { parseProfile } from "../../src/services/browser-page-tools.ts";

it.effect("retains decoded profile keys and Variable values", () =>
  Effect.gen(function* scrubProfiles() {
    const secret = 'private"\\\nvalue';
    for (const capture of [
      {
        nodes: [
          {
            callFrame: { functionName: secret, url: `https://test/${secret}` },
          },
        ],
      },
      {
        traceEvents: [
          { args: { [secret]: [secret, 42, null, true] }, name: secret },
        ],
      },
    ]) {
      const data = yield* parseProfile(JSON.stringify(capture), [secret]);
      expect(data).toContain(JSON.stringify(secret).slice(1, -1));

      expect(JSON.parse(data)).toEqual(capture);
    }
  })
);
