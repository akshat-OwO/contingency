import { UserAgentProfileId } from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { Effect, Scope } from "effect";

import { makeChromiumAgentBrowser } from "../../src/services/chromium-agent-browser.ts";
import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  CONTRACT_URL,
  agentBrowserContract,
} from "../helpers/agent-browser-contract.ts";

agentBrowserContract(
  "Chromium",
  () =>
    Effect.gen(function* realAgentBrowser() {
      const browser = yield* CreateBrowser;
      const viewport = { deviceScaleFactor: 1, height: 480, width: 640 };
      const sessionId = yield* browser.create(
        "create-contract",
        viewport,
        true
      );
      yield* Effect.addFinalizer(() =>
        browser.close(sessionId).pipe(Effect.ignore)
      );
      yield* browser.open(sessionId, CONTRACT_URL, {
        permissions: [],
        userAgentProfile: UserAgentProfileId.make("chrome-mac"),
        viewport,
      });
      return yield* makeChromiumAgentBrowser({
        browser,
        now: () => new Date(),
        scope: yield* Scope.Scope,
        sessionId,
      });
    }),
  (test) =>
    test.pipe(
      Effect.provide(CreateBrowserLive),
      Effect.provide(NodeServices.layer)
    )
);
