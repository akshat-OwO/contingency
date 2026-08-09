#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { commands } from "./cmds/index.js";
import { AgentBrowserLive } from "./services/agent-browser.js";

const servicesLayer = AgentBrowserLive.pipe(
  Layer.provideMerge(NodeServices.layer)
);

Command.run(commands, { version: packageJson.version }).pipe(
  Effect.provide(servicesLayer),
  NodeRuntime.runMain
);
