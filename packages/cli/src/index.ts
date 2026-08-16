#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { commands } from "./cmds/index";
import { AgentBrowserLive } from "./services/agent-browser";
import { RecordingLive } from "./services/cdp-recorder";
import { RunnerLive } from "./services/runner";
import { UiInterfaceLive } from "./services/ui-interface";

const browserAndRecordingLayer = Layer.merge(
  AgentBrowserLive,
  RecordingLive.pipe(Layer.provide(AgentBrowserLive))
);
const servicesLayer = Layer.mergeAll(
  browserAndRecordingLayer,
  UiInterfaceLive.pipe(Layer.provide(browserAndRecordingLayer)),
  RunnerLive.pipe(Layer.provide(AgentBrowserLive))
).pipe(Layer.provideMerge(NodeServices.layer));

Command.run(commands, { version: packageJson.version }).pipe(
  Effect.provide(servicesLayer),
  NodeRuntime.runMain
);
