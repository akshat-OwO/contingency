import { Console, Effect } from "effect";
import { Command } from "effect/unstable/cli";

import { AgentBrowser } from "../services/agent-browser.js";

export const commands = Command.make("contingency", {}, () =>
  Effect.gen(function* runContingency() {
    const agentBrowser = yield* AgentBrowser;

    yield* agentBrowser.init();
    yield* Console.log("Hello from contigency");
  })
);
