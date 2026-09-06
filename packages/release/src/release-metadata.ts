import { Data, Result } from "effect";

/**
 * The npm distribution tag a release is published under.
 *
 * `latest` is what a bare `npm install @contingencyhq/cli` resolves to, so
 * nothing reaches it by accident: only a plain `vX.Y.Z` tag produces it.
 * Every prerelease identifier becomes its own channel, which means `alpha`
 * exists because someone tagged `v0.2.0-alpha.1`, not because a job ran.
 */
export type ReleaseChannel = string;

export interface ReleaseMetadata {
  /** The version as published to npm, without a leading `v`. */
  readonly version: string;
  /** The git tag that carries this version. */
  readonly tag: string;
  /** The npm dist-tag to publish under. */
  readonly distTag: ReleaseChannel;
  /** Whether the GitHub Release is marked as a prerelease. */
  readonly isPrerelease: boolean;
  /** Whether this release becomes the repository's "latest" release. */
  readonly makeLatest: boolean;
  /** Human-facing release title. */
  readonly name: string;
}

export class InvalidReleaseVersionError extends Data.TaggedError(
  "InvalidReleaseVersionError"
)<{ readonly input: string }> {
  override get message(): string {
    return `'${this.input}' is not a release version. Expected a semantic version such as 1.2.3 or 1.2.3-alpha.4, optionally prefixed with 'v'.`;
  }
}

/**
 * Semantic version, anchored, with the prerelease identifier captured.
 *
 * Build metadata (`+sha`) is deliberately unsupported: npm ignores it when
 * resolving versions, so two releases differing only there would collide on
 * the registry while looking distinct in git.
 */
const SEMVER =
  /^v?(?<core>\d+\.\d+\.\d+)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/**
 * The leading dot-separated segment of a prerelease is the channel: the `4`
 * in `alpha.4` is a counter, not a second channel name.
 */
const channelOf = (prerelease: string): string => {
  const [identifier] = prerelease.split(".");
  return identifier === undefined || identifier === ""
    ? "prerelease"
    : identifier;
};

/**
 * Derives everything a release run needs from the version alone.
 *
 * The version is the single input on purpose. A tag push and a manual
 * dispatch of the same version must produce byte-identical decisions, so
 * neither the event name nor the branch is allowed to influence the outcome.
 */
export const resolveReleaseMetadata = (
  input: string
): Result.Result<ReleaseMetadata, InvalidReleaseVersionError> => {
  const match = SEMVER.exec(input.trim());
  const core = match?.groups?.core;
  if (core === undefined) {
    return Result.fail(new InvalidReleaseVersionError({ input }));
  }

  const prerelease = match?.groups?.prerelease;
  const version = prerelease === undefined ? core : `${core}-${prerelease}`;
  const isPrerelease = prerelease !== undefined;

  return Result.succeed({
    distTag: isPrerelease ? channelOf(prerelease) : "latest",
    isPrerelease,
    makeLatest: !isPrerelease,
    name: `v${version}`,
    tag: `v${version}`,
    version,
  });
};
