# CLI footprint CI

The CLI footprint workflow builds the PR head and its exact base commit sequentially with the same Node, Nub, npm 12.2.0, and placeholder release version. It uses the release build command and `npm pack --ignore-scripts --json`, then installs each tarball offline with lifecycle scripts disabled. It does not alter publication.

The report compares packed tarball bytes, installed regular file bytes, and installed file count against main, npm latest, and npm alpha. Published baselines come from `npm pack @contingencyhq/cli@latest` and `@alpha`; each column labels the version in the installed tarball. Missing tags and registry failures become `n/a`. Logical file lengths exclude filesystem block allocation, npm cache, lockfiles, and bin links. The CLI bundles its runtime dependencies, so an offline install also preserves the release check's no-registry-dependencies invariant.

All positive deltas are marked. A warning annotation appears when growth against main or npm latest exceeds 1% OR 51,200 bytes for either size metric. File counts use only the percentage limit. Alpha is informational. Repository variables `CLI_FOOTPRINT_WARN_BYTES` and `CLI_FOOTPRINT_WARN_PERCENT` override these defaults. Growth does not fail the job. Build, pack, or local install errors do fail it; unavailable registry baselines do not.

Measurement runs with read-only permissions and checkout credentials disabled. The separate comment job has `actions: read` and `pull-requests: write`; it reads the report as text and never checks out or executes PR code. It updates the bot comment identified by `<!-- contingency-cli-footprint -->`, and ignores superseded heads. Fork PRs receive the job summary and downloadable artifact, but no comment because their token cannot write PR comments. No `pull_request_target` or privileged `workflow_run` executes fork code.

To measure an already built tree locally:

```sh
nub packages/release/src/footprint-main.ts measure --output /tmp/head.json
nub packages/release/src/footprint-main.ts registry --output /tmp/registry.json
nub packages/release/src/footprint-main.ts compare /tmp/base.json /tmp/head.json /tmp/registry.json --output /tmp/footprint.md
```

Use a separately measured base snapshot for `/tmp/base.json`. The comparison command prints the Markdown report and warning annotations. JSON snapshots and the Markdown report remain available as CI artifacts for seven days.
