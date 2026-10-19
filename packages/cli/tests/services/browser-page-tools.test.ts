import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { redactProfile } from "../../src/services/browser-page-tools.ts";

it.effect("scrubs decoded profile keys and values recursively", () =>
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
      const data = yield* redactProfile(JSON.stringify(capture), [secret]);
      expect(data).not.toContain(JSON.stringify(secret).slice(1, -1));
      expect(data).toContain("[sensitive input]");
      expect(JSON.parse(data)).toEqual(
        "nodes" in capture
          ? {
              nodes: [
                {
                  callFrame: {
                    functionName: "[sensitive input]",
                    url: "https://test/[sensitive input]",
                  },
                },
              ],
            }
          : {
              traceEvents: [
                {
                  args: {
                    "[sensitive input]": ["[sensitive input]", 42, null, true],
                  },
                  name: "[sensitive input]",
                },
              ],
            }
      );
    }
  })
);
