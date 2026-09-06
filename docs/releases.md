# Releases

`@contingencyhq/cli` is the only published package. The web app and the protocol package are private and ship inside its `dist`.

The scope is `@contingencyhq` rather than `@contingency` because that org name was already taken. The installed binary is still `contingency`, so the scope shows up at install time and nowhere else.

## Cutting a release

Push a tag. That is the whole procedure.

```sh
git tag v0.2.0 && git push origin v0.2.0        # -> npm dist-tag: latest
git tag v0.2.0-alpha.1 && git push origin v0.2.0-alpha.1   # -> npm dist-tag: alpha
```

The prerelease identifier **is** the channel. `v1.0.0-beta.3` publishes to `beta` and `v1.0.0-rc.1` to `rc`, with no workflow change required to open one. A plain `vX.Y.Z` is the only thing that ever reaches `latest`, so a bare `npm install @contingencyhq/cli` cannot resolve to a prerelease even when the prerelease sorts higher.

`workflow_dispatch` runs the same pipeline with an explicit version, and defaults to `dry_run: true`, which builds and packs but publishes nothing.

## Versions are not committed

`packages/cli/package.json` carries a placeholder. The release workflow stamps the tag's version into it at build time and never commits the result, so `main` never claims a version that has not shipped and no pull request has to be rebased over someone else's bump. The git tag is the record of what a release was; the manifest is a build input.

The same step removes `workspace:` and `catalog:` dependencies, which nub resolves and npm does not. npm rejects an installed package carrying one with `EUNSUPPORTEDPROTOCOL`. Today they all sit in fields npm ignores for an installed dependency, so this prevents a latent break rather than a current one: moving a `catalog:` dependency into `dependencies` would otherwise break every install with nothing to catch it. The protocol package is the only workspace dependency, and tsdown inlines it into `dist`, so dropping the declaration costs the published code nothing.

The CLI's `--version` is inlined into the bundle at build time rather than read from `package.json` at runtime, which makes the order load-bearing: stamp, then build. The publish job asserts the built binary reports the tag's version before anything is published.

This is why the repo has no changesets: with one publishable package and no inter-package version graph, the accumulate-and-bump machinery has nothing to coordinate.

## What runs before anything is published

1. **Preflight** resolves the version, rejects anything that is not a semantic version, and fails if that version already exists on npm — registry versions are immutable, so a re-tag has to become a new version.
2. **Quality** and **Integration** run the same gate as CI, against the exact commit being published. A tag can point at any commit, including one that never went through a pull request, so this is not redundant.
3. **Publish** stamps the version, builds, packs, and publishes with npm provenance, then creates the GitHub Release with the tarball attached.

The publish job is serialized (`concurrency: release`, no cancellation): a run killed between `npm publish` and the GitHub Release would leave a version on the registry with nothing in git behind it.

## Where things live

| Path | Role |
| --- | --- |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | The pipeline |
| [`packages/release/src/release-metadata.ts`](../packages/release/src/release-metadata.ts) | Version → dist-tag and release flags |
| [`packages/release/src/apply-version.ts`](../packages/release/src/apply-version.ts) | Prepares the published manifest |
| [`packages/release/src/publishable-packages.ts`](../packages/release/src/publishable-packages.ts) | Which manifests get stamped |

Both commands are runnable by hand; without `GITHUB_OUTPUT` set they print to stdout.

```sh
node packages/release/src/main.ts resolve v0.2.0-alpha.4
node packages/release/src/main.ts apply-version 0.2.0-alpha.4
```

## Authentication

The workflow holds no npm credentials. It authenticates with npm's trusted publishing: GitHub mints a short-lived OIDC token for the run, and npm exchanges it for publish rights after checking the run came from this repository and this workflow file. There is no `NPM_TOKEN` to leak or rotate.

Two settings make that work, and both are matched exactly:

- The npm package's trusted publisher names the GitHub owner (`akshat-OwO`), the repository, the workflow filename (`release.yml`), and the environment (`release`). Renaming or moving `.github/workflows/release.yml` breaks publishing until that setting is updated to match.
- The `release` GitHub environment must exist. It is named in the trusted publisher config, so it is load-bearing rather than decorative, and it is where a required-reviewer gate belongs if publishing should need a human.

No secrets are configured on this repository.
