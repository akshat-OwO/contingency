import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { vendorDisplayTransport } from "./vendor-display-transport.ts";
import { vendorPackages } from "./vendor-packages.ts";

vendorPackages(
  // mediabunny is the hub recorder's MP4 muxer; the hub itself is copied
  // file by file below.
  [
    "playwright-core",
    "lighthouse",
    "puppeteer-core",
    "agent-device",
    "mediabunny",
  ],
  process.cwd(),
  path.resolve("dist")
).pipe(
  Effect.andThen(vendorDisplayTransport(process.cwd(), path.resolve("dist"))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
