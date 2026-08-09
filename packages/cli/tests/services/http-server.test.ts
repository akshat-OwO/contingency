import path from "node:path";

import { expect, it } from "@effect/vitest";

import {
  isAllowedWebSocketOrigin,
  resolveWebRoot,
} from "../../src/services/http-server";

it("accepts only configured WebSocket origins", () => {
  const allowedOrigins = new Set(["http://localhost:5173"]);

  expect(
    isAllowedWebSocketOrigin("http://localhost:5173", allowedOrigins)
  ).toBe(true);
  expect(
    isAllowedWebSocketOrigin("https://malicious.example", allowedOrigins)
  ).toBe(false);
  expect(isAllowedWebSocketOrigin(undefined, allowedOrigins)).toBe(false);
});

it("resolves bundled web assets from source modules", () => {
  const moduleDirectory = path.join(
    path.parse(process.cwd()).root,
    "repo",
    "packages",
    "cli",
    "src",
    "services"
  );

  expect(resolveWebRoot(moduleDirectory)).toBe(
    path.join(
      path.parse(process.cwd()).root,
      "repo",
      "packages",
      "cli",
      "dist",
      "web"
    )
  );
});

it("resolves bundled web assets beside the production entrypoint", () => {
  const moduleDirectory = path.join(
    path.parse(process.cwd()).root,
    "repo",
    "packages",
    "cli",
    "dist"
  );

  expect(resolveWebRoot(moduleDirectory)).toBe(
    path.join(moduleDirectory, "web")
  );
});
