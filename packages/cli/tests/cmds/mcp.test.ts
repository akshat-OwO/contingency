import { expect, it } from "@effect/vitest";
import { HttpServerError } from "effect/http";

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
