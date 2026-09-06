# Contingency

Author website Flows, re-run them, and report accessibility and performance Findings. A Flow you record in the browser is the same Flow your CI runs headlessly, so the check that passed on your machine is the check that runs on every commit.

Contingency also teaches agents. You demonstrate a journey once, an agent compiles it into a reusable Agent Flow, and you approve it before it ever runs on its own.

```sh
npm install -g @contingencyhq/cli
contingency web
```

Usage lives in [`packages/cli/README.md`](./packages/cli/README.md), which is also the npm landing page.

## Repository

A Turborepo workspace managed by [`nub`](https://github.com/nubjs/nub). One package publishes; the rest are private and ship inside it.

| Path | What it is |
| --- | --- |
| `packages/cli` | `@contingencyhq/cli`, the Runner, MCP server, and web server |
| `packages/protocol` | Shared schemas and RPC contracts, bundled into the CLI |
| `packages/release` | Release tooling the publish workflow runs |
| `apps/web` | Create View, Audit View, and Agent View, built into the CLI |

## Development

```sh
nub install
nub run dev
```

`nub run dev` starts the CLI and the Vite dev server together. Vite proxies `/ws` to the CLI, so open the Vite URL and changes on either side reload.

## Checks

```sh
nub exec turbo run quality          # lint and formatting, read-only
nub exec turbo run quality:fix      # apply the safe fixes
nub exec turbo run check-types test # types and unit tests
nub exec turbo run test:integration # real Chromium, slower by an order of magnitude
```

The integration suite launches a browser per test file and needs Chromium plus `ffprobe`:

```sh
nub exec --cwd packages/cli playwright-core install chromium
```

## Documentation

| Doc | Role |
| --- | --- |
| [`CONTEXT.md`](./CONTEXT.md) | The glossary. Read this first; the terms are precise and load-bearing |
| [`docs/adr/`](./docs/adr/) | Decisions that would be expensive to reverse |
| [`docs/releases.md`](./docs/releases.md) | Cutting and publishing a release |
| [`docs/`](./docs/) | Everything else |
