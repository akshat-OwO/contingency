import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { resolveReleaseMetadata } from "../src/release-metadata.ts";

const resolve = (input: string) =>
  Result.getOrThrow(resolveReleaseMetadata(input));

describe("resolveReleaseMetadata", () => {
  it("publishes a plain version to latest", () => {
    expect(resolve("v1.2.3")).toStrictEqual({
      distTag: "latest",
      isPrerelease: false,
      makeLatest: true,
      name: "v1.2.3",
      tag: "v1.2.3",
      version: "1.2.3",
    });
  });

  it("accepts a version with or without the v prefix", () => {
    expect(resolve("1.2.3")).toStrictEqual(resolve("v1.2.3"));
  });

  it("routes a prerelease to a dist-tag named after its identifier", () => {
    expect(resolve("v0.2.0-alpha.4")).toStrictEqual({
      distTag: "alpha",
      isPrerelease: true,
      makeLatest: false,
      name: "v0.2.0-alpha.4",
      tag: "v0.2.0-alpha.4",
      version: "0.2.0-alpha.4",
    });
  });

  it("keeps a prerelease off latest even when it sorts highest", () => {
    const metadata = resolve("v9.9.9-alpha.1");
    expect(metadata.distTag).not.toBe("latest");
    expect(metadata.makeLatest).toBe(false);
  });

  it("treats the counter as part of the version, not the channel", () => {
    expect(resolve("v1.0.0-alpha.1").distTag).toBe("alpha");
    expect(resolve("v1.0.0-alpha.99").distTag).toBe("alpha");
  });

  it("supports channels other than alpha without configuration", () => {
    expect(resolve("v1.0.0-beta.1").distTag).toBe("beta");
    expect(resolve("v1.0.0-rc.1").distTag).toBe("rc");
  });

  it("names a bare prerelease identifier explicitly", () => {
    expect(resolve("v1.0.0-alpha").distTag).toBe("alpha");
  });

  it.each([
    ["", "empty"],
    ["1.2", "partial version"],
    ["v1.2.3.4", "four segments"],
    ["latest", "a dist-tag rather than a version"],
    ["v1.2.3+build.5", "build metadata npm would discard"],
  ])("rejects %o (%s)", (input) => {
    const result = resolveReleaseMetadata(input);
    expect(Result.isFailure(result)).toBe(true);
  });
});
