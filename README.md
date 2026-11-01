# Contingency

Monitor whether your product's features still work. You demonstrate a journey once, an agent learns a reusable Flow Skill from the recording, and you verify it after a Dry Run before it runs on its own.

```sh
npx @contingencyhq/cli start --demo
```

Usage lives in [`packages/cli/README.md`](./packages/cli/README.md), which is also the npm landing page.

## Repository

A Turborepo workspace managed by [Vite+](https://viteplus.dev/) with pnpm 12.16.1. One package publishes; the rest are private and ship inside it.

| Path | What it is |
| --- | --- |
| `packages/cli` | `@contingencyhq/cli`, the MCP server, browser runtime, and web server |
| `packages/protocol` | Shared schemas and RPC contracts, bundled into the CLI |
| `packages/release` | Release tooling the publish workflow runs |
| `apps/web` | The Workspace, built into the CLI |

## Development

Install Vite+ 1.4.0 with the [global CLI installer](https://viteplus.dev/guide/global-cli). Use `vp run <script>` for package scripts and `vpx <file>` for TS/JS files. Built-in commands such as `vp test` do not run this repository's scripts.

```sh
vp install
vp run dev
```

`vp run dev` starts `contingency web` and the Vite dev server together. Vite proxies `/ws` to the CLI, so open the Vite URL and changes on either side reload. That loop serves the Workspace over the local catalog; it owns no Agent Sessions, so run `vp exec --filter @contingencyhq/cli contingency mcp` in its own terminal to teach a journey or drive an Interactive Run.

## Checks

```sh
vp exec turbo run quality          # lint and formatting, read-only
vp exec turbo run quality:fix      # apply the safe fixes
vp exec turbo run check-types test # types and unit tests
vp exec turbo run test:integration # real Chromium, slower by an order of magnitude
```

The integration suite launches a browser per test file and needs Chromium plus `ffprobe`:

```sh
vp exec --filter ./packages/cli playwright-core install chromium
```

## Documentation

| Doc | Role |
| --- | --- |
| [`GLOSSARY.md`](./GLOSSARY.md) | The glossary. Read this first; the terms are precise and load-bearing |
| [`docs/adr/`](./docs/adr/) | Decisions that would be expensive to reverse |
| [`docs/releases.md`](./docs/releases.md) | Cutting and publishing a release |
| [`docs/`](./docs/) | Everything else |
