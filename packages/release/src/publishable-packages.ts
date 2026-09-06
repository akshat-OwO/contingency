/**
 * Every manifest whose `version` field the release stamps, relative to the
 * repository root.
 *
 * Only `@contingencyhq/cli` is published. The web app and the protocol package
 * are private and ship inside the CLI's `dist`, so a version on them would be
 * a number nobody can install and nobody can check.
 */
export const publishableManifests = ["packages/cli/package.json"] as const;
