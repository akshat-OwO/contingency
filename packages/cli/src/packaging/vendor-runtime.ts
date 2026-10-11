import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";

import { vendorPackages } from "./vendor-packages.ts";

vendorPackages(
  ["playwright-core", "lighthouse", "puppeteer-core"],
  process.cwd(),
  path.resolve("dist")
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
