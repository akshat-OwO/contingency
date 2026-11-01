---
status: accepted
---

# Vite+ runs packages and scripts

The repository replaces nub with Vite+ 1.4.0 for package management and script execution. pnpm 12.16.1 is the underlying package manager. It supports the existing `workspace:` links and default and named `catalog:` dependencies without expanding versions into every manifest.

## Rules

- `packageManager` pins pnpm, because Vite+ uses that field to select its underlying manager. `vite-plus` pins the local runner to 1.4.0. The global CLI and CI setup use the same version.
- `pnpm-workspace.yaml` owns workspace globs and catalogs. `pnpm-lock.yaml` replaces `nub.lock`. The initial install starts from the compatible version 9 lockfile to retain dependency resolutions.
- Use `vp install` locally and `vp install --frozen-lockfile` in CI. Use `vp run <script>` for package scripts and `vp exec <binary>` for installed commands. Select another workspace with `--filter <package-name>` or a directory filter such as `--filter ./packages/cli`.
- Use `vpx <file>` for TypeScript and JavaScript and `vpx --watch <file>` for reloads. Vite+ ships its own TypeScript loader, including support for `.js` imports of `.ts` sources and tsconfig paths. Remove `@nubjs/types`; Node types describe the runtime APIs used here.
- Keep Turbo, Vite, Vitest, tsdown, Oxlint, and Oxfmt and their existing configuration. This decision changes package and script execution. Built-ins such as `vp build` and `vp test` do not replace the repository's scripts.
- CI uses `voidzero-dev/setup-vp@v1.22.0` with Vite+ 1.4.0, dependency caching, and explicit frozen installs. The footprint job adapts an older base's package-manager metadata before building, without editing its product sources.
- The Android checkout fixture remains independent. Its own pnpm lockfile and workspace settings preserve hoisting and exact trust-policy exemptions. Dependency build permissions live in workspace settings, including the existing refusal for `node-datachannel`.

## Considered options

- **pnpm, chosen.** Preserves workspace and catalog semantics, and consumes the existing lockfile format as the migration seed.
- **npm.** Does not resolve the existing catalog dependencies.
- **Yarn or Bun.** Can support catalogs, but require a different lockfile conversion and offer no compatibility advantage for this repository.
- **Node type stripping.** Sufficient for some scripts on Node 24, but Vite+'s file runner also handles the repository's bundler-style imports and watch workflow.

## References

- [Vite+ package management](https://viteplus.dev/guide/package-management)
- [Vite+ file and binary execution](https://viteplus.dev/guide/vpx)
- [Vite+ task execution](https://viteplus.dev/guide/run)
- [Vite+ CI setup](https://viteplus.dev/guide/ci)
- [pnpm workspace settings](https://pnpm.io/settings)
