import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  resolveAllowedOrigins,
  resolveBrowserUrl,
} from "../../src/services/web-url";

it.effect("uses the Vite URL during development", () =>
  Effect.gen(function* useDevelopmentUrl() {
    const url = yield* resolveBrowserUrl({
      devUrl: "http://localhost:5173",
      host: "127.0.0.1",
      isProduction: false,
      port: 7777,
      publicUrl: Option.none(),
    });

    expect(url.href).toBe("http://localhost:5173/");
  })
);

it.effect("uses the CLI server URL in production", () =>
  Effect.gen(function* useProductionUrl() {
    const url = yield* resolveBrowserUrl({
      devUrl: "http://localhost:5173",
      host: "localhost",
      isProduction: true,
      port: 7777,
      publicUrl: Option.none(),
    });

    expect(url.href).toBe("http://127.0.0.1:7777/");
  })
);

it.effect("supports IPv6 production hosts", () =>
  Effect.gen(function* useIpv6ProductionUrl() {
    const url = yield* resolveBrowserUrl({
      devUrl: "http://localhost:5173",
      host: "2001:db8::1",
      isProduction: true,
      port: 7777,
      publicUrl: Option.none(),
    });

    expect(url.href).toBe("http://[2001:db8::1]:7777/");
  })
);

it.effect("prefers an explicitly configured public URL", () =>
  Effect.gen(function* usePublicUrl() {
    const url = yield* resolveBrowserUrl({
      devUrl: "http://localhost:5173",
      host: "127.0.0.1",
      isProduction: true,
      port: 7777,
      publicUrl: Option.some("https://contingency.example/ui"),
    });

    expect(url.href).toBe("https://contingency.example/ui");
  })
);

it.effect("reports invalid URLs as typed failures", () =>
  Effect.gen(function* rejectInvalidUrl() {
    const error = yield* Effect.flip(
      resolveBrowserUrl({
        devUrl: "not a URL",
        host: "127.0.0.1",
        isProduction: false,
        port: 7777,
        publicUrl: Option.none(),
      })
    );

    expect(error._tag).toBe("WebUrlError");
    expect(error.message).toContain("not a URL");
  })
);

it("allows equivalent loopback browser origins", () => {
  const origins = resolveAllowedOrigins(new URL("http://localhost:5173"));

  expect(origins).toEqual(
    new Set([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ])
  );
});

it("does not widen non-loopback origins", () => {
  const origins = resolveAllowedOrigins(new URL("https://contingency.example"));

  expect(origins).toEqual(new Set(["https://contingency.example"]));
});
