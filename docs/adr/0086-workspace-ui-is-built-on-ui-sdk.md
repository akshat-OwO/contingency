---
status: accepted
---

# Workspace UI is built on UI SDK

> Decided in [#740](https://github.com/akshat-OwO/contingency/issues/740), with the spike verdict from [#742](https://github.com/akshat-OwO/contingency/issues/742).

The Workspace (`apps/web`) used shadcn components on Base UI. Coding agents could copy those components but could not reliably build new ones that matched them. UI SDK (`@ui-sdk/core`, `@ui-sdk/react`) declares each Behavior, such as popups, selection and dismissal, and builds its components from them. Agents can therefore compose existing Primitives or declare new ones with `definePrimitive`, and get the same keyboard, focus and ARIA handling. UI SDK is now the component layer for all Workspace UI.

## Rules

- **`@/components/ui/*` is the only import surface.** Feature code imports Primitives from the facade, never from `@ui-sdk/*`. Facade files keep their export names and `data-slot` values, because `styles.css` and tests key off them. Only `apps/web/src/components/ui/` imports `@ui-sdk/*`. Tests may also import the testing kit, `@ui-sdk/core/testing`.
- **New Workspace UI uses UI SDK.** The `no-restricted-imports` guard in `oxlint.config.ts` bans `@base-ui/react`, `shadcn`, `@shadcn/react` and the libraries UI SDK covers (`cmdk`, `vaul`, `sonner`, `react-resizable-panels`, `embla-carousel-react`, `react-day-picker`, `input-otp`) everywhere, including `components/ui/`. None of them is installed. `recharts` and `lucide-react` stay.
- **The island look is the default.** A Primitive with an island look renders it when the caller names no variant: a bare `Button` is the quiet island control, and `Input`, `Select`, `Tabs` and `DropdownMenu` render their island forms. Other looks are asked for by name, such as `variant="primary"` or `size="md"` on `Button` and `variant="compact"` on `Input` and `Select` for dense panels. A variant nothing uses is deleted.
- **Versions are pinned exactly.** `@ui-sdk/core` and `@ui-sdk/react` are pinned at the same exact version, currently `0.1.0-beta.5`. UI SDK is a public beta, launched 2026-11-12. Each upgrade gets its own PR with the per-PR gate from #740 (ARIA snapshots, testing kit, light and dark screenshots). The `minimumReleaseAgeExclude` entries in `pnpm-workspace.yaml` cover only these pinned packages. Remove them once the pinned release is older than the release-age policy.
- **The agent bridge stays off.** Do not use `createAgent`, agent tools or WebMCP. [ADR 0072](./0072-single-tool-is-the-only-mcp-interface.md) remains in force: the single MCP tool is the only agent interface, and runtime agents read the Workspace only through its ARIA tree. The `ui-sdk` skill includes an "agent-ready" step. Skip it in this repo. A later ADR may revisit the bridge.

## Spike verdict

The #742 spike moved Select, Popover, Tooltip, Dialog, Sheet, Alert Dialog and the `Agent Session` combobox onto UI SDK. No no-go condition was hit on web, Android or iOS, so no Primitive stays on Base UI because of the spike. The Primitives still on Base UI are there only because they have not been migrated yet. The spike found these differences:

- **Inert background.** While a modal Dialog or Sheet is open, UI SDK marks the rest of the page `inert` instead of `aria-hidden`. Chromium's accessibility tree is unchanged, but Playwright `--aria` snapshots now include the inert background. `verify-contingency` treats this as a known contract change.
- **Select has no scroll arrows.** `SelectScrollUpButton` and `SelectScrollDownButton` render nothing. `SelectItemText` renders a plain span, because UI SDK's own version renders the item's label rather than its children.
- **A non-modal dialog handles Escape only while focus is inside it.** A control that unmounts while it has focus must return focus inside the dialog. The comment composer does this.

## Considered Options

- **Stay on shadcn and Base UI.** Rejected: agents could copy existing components but could not reliably build new ones that matched them.
- **Import UI SDK directly in feature code.** Rejected: the facade keeps `data-slot` styling, test queries and future upgrades in one place.
- **Turn on `createAgent` and WebMCP.** Rejected for now: it would add a second agent interface beside the single MCP tool, contrary to ADR 0072.

## Consequences

- `apps/web/src/components/ui/` is linted like the rest of the repo. [#787](https://github.com/akshat-OwO/contingency/issues/787) removed its Oxlint ignore and the `uiMigrationExceptions` list, along with Base UI, the shadcn tooling, `components.json` and the unused Toggle, Toggle Group, Empty and Separator facades.
- The guard sees only JS and TS imports. `styles.css` no longer imports `shadcn/tailwind.css`; the three state variants the Primitives use (`data-open`, `data-checked`, `data-disabled`) are defined there instead.
