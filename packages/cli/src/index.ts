import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { commands } from "@/cmds/index";
import { AgentBrowserLive } from "@/services/agent-browser";

import packageJson from "../package.json" with { type: "json" };

const servicesLayer = AgentBrowserLive.pipe(
  Layer.provideMerge(NodeServices.layer)
);

Command.run(commands, { version: packageJson.version }).pipe(
  Effect.provide(servicesLayer),
  NodeRuntime.runMain
);
