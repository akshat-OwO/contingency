import { expect, it } from "@effect/vitest";
import { HttpServerError } from "effect/http";
import { PlatformError, SystemError } from "effect/PlatformError";

import { isListenAddressInUse } from "../../src/cmds/mcp.ts";

it("recognizes an occupied port across separate Effect error prototypes", () => {
  const cause = Object.assign(new Error("address already in use"), {
    code: "EADDRINUSE",
  });
  const error = new HttpServerError.ServeError({ cause });
  // A separately installed Effect copy has a different ServeError prototype.
  Object.setPrototypeOf(error, Error.prototype);

  expect(error instanceof HttpServerError.ServeError).toBe(false);
  expect(isListenAddressInUse(error)).toBe(true);
});

it.each([undefined, new Error("bind failed"), { code: "EACCES" }])(
  "does not treat another bind failure as an occupied port: %s",
  (cause) => {
    expect(
      isListenAddressInUse(new HttpServerError.ServeError({ cause }))
    ).toBe(false);
  }
);

it("does not classify another error tag by its EADDRINUSE cause", () => {
  const error = new PlatformError(
    new SystemError({
      _tag: "Unknown",
      cause: { code: "EADDRINUSE" },
      method: "listen",
      module: "HttpServer",
    })
  );

  expect(isListenAddressInUse(error)).toBe(false);
});
