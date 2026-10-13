import { Effect, Layer } from "effect";

import { makeAndroidRuntimeFactory } from "./android-runtime.ts";
import { makeChromiumAgentBrowser } from "./chromium-agent-browser.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import {
  makeBrowserRuntimeFactory,
  makePlatformRuntimeFactory,
  PlatformRuntimeFactory,
} from "./platform-runtime.ts";

export const PlatformRuntimeFactoryLive = Layer.effect(
  PlatformRuntimeFactory,
  Effect.gen(function* runtimeFactory() {
    const browser = yield* CreateBrowser;
    return makePlatformRuntimeFactory(
      makeBrowserRuntimeFactory(browser, makeChromiumAgentBrowser),
      makeAndroidRuntimeFactory()
    );
  })
);
