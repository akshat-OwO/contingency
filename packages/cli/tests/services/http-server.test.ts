import path from "node:path";

import { expect, it } from "@effect/vitest";

import { isValidRpcToken } from "../../src/routes/rpc";
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

it("requires an exact RPC authentication token", () => {
  expect(isValidRpcToken("launch-token", "launch-token")).toBe(true);
  expect(isValidRpcToken("wrong-token", "launch-token")).toBe(false);
  expect(isValidRpcToken(undefined, "launch-token")).toBe(false);
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
