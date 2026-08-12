# agent-browser website-permission support

Status checked: 2026-08-12

## Conclusion

General website-permission controls are not visibly in active development upstream. There is no public, documented command for origin-scoped `allow`, `block`, or `default`/reset, and no issue or pull request explicitly tracking that complete API. The only direct upstream request is open issue [#1322](https://github.com/vercel-labs/agent-browser/issues/1322), which asks for geolocation pre-granting or an `--allow-geolocation` option. It is an untriaged request, not a confirmed roadmap item: as of the check date it has no comments, labels, assignee, milestone, project, or linked pull request.

The supported interim scope remains coordinate emulation via `set geo`. It cannot honestly provide origin-specific permission state or a reliable public clear/reset operation.

## Repository and release checked

The canonical repository is [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser). The official [`package.json` at v0.34.0](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/package.json) names that repository, and Contingency bundles version 0.33.2. The latest upstream release inspected was [v0.34.0](https://github.com/vercel-labs/agent-browser/releases/tag/v0.34.0), published 2026-08-11; its release notes contain no permission, geolocation, or media-device work. GitHub Discussions are disabled for the repository.

## Explicit upstream signals

| Item | Status on 2026-08-12 | What it establishes |
| --- | --- | --- |
| [Issue #1322](https://github.com/vercel-labs/agent-browser/issues/1322), “session-setup doesn't pre-grant geolocation” | Open; created and last updated 2026-05-03; no comments, labels, assignee, milestone, project, or linked PR | A user requested `Browser.grantPermissions({ permissions: ["geolocation"] })` or `--allow-geolocation`. This is the only direct request found, but there is no maintainer commitment or active implementation. |
| [Draft PR #1618](https://github.com/vercel-labs/agent-browser/pull/1618), dashboard clipboard bridge | Open draft; created 2026-07-28; last updated 2026-07-31; review required | It proposes granting `clipboard-read` and `clipboard-write` internally when a screencast starts. It is not a general public permission API and does not provide origin-scoped ask/allow/block/reset. |
| [PR #749](https://github.com/vercel-labs/agent-browser/pull/749), clipboard CLI commands | Merged 2026-03-13 | Clipboard read/write/copy/paste operations are public, but these are operations rather than controls for the page's Clipboard API permission state. |

Searches of official issues, pull requests, and commits found no explicit work item for public `Browser.setPermission`, allow/deny/reset controls, `Browser.resetPermissions`, geolocation clear/reset, camera or microphone permissions, notifications permissions, `getUserMedia`, or fake media devices. Absence of a search result is not a guarantee about private plans; it only means there is no public upstream signal in the inspected repository.

## Current implementation

- Both the bundled [v0.33.2 README](https://github.com/vercel-labs/agent-browser/blob/v0.33.2/README.md#emulation) and current public docs expose `agent-browser set geo <lat> <lng>`. The [v0.33.2 parser](https://github.com/vercel-labs/agent-browser/blob/v0.33.2/cli/src/commands.rs#L2881-L2902) accepts two coordinates and has no clear/reset form.
- The [v0.33.2 native browser implementation](https://github.com/vercel-labs/agent-browser/blob/v0.33.2/cli/src/native/browser.rs#L1615-L1644) calls `Emulation.setGeolocationOverride`; it does not call `Emulation.clearGeolocationOverride`.
- A permission action exists internally in v0.33.2: the [daemon action](https://github.com/vercel-labs/agent-browser/blob/v0.33.2/cli/src/native/actions.rs#L6952-L6981) calls the native browser's `Browser.grantPermissions` helper. It is absent from public CLI parsing and documentation, supplies no origin, supports grants only, and uses CDP's deprecated grant API rather than `Browser.setPermission`. It arrived with the [native rewrite commit/PR #594](https://github.com/vercel-labs/agent-browser/commit/51f5fa484c910913fa51bbc8f12d064282926b68) on 2026-03-03, so it is existing private protocol machinery rather than recent work toward a supported interface.
- The public [clipboard documentation](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/docs/src/app/files/page.mdx#clipboard) covers reading, writing, copying, and pasting. It does not expose `clipboard-read`/`clipboard-write` permission policy.
- The generic `--args` option could pass Chromium launch switches, but no first-class fake-versus-real camera/microphone mode or permission API was found. Using launch flags would therefore be an inference/workaround, not an upstream-supported permission feature.

## Product implication

Proceed with the clearly labelled geolocation-coordinate emulator only. Do not present it as granting location access, resetting an override, or enforcing origin-specific permission state. Defer the lock/site-permissions UI until agent-browser publishes a supported permission surface. Recheck issue #1322 and upstream release notes when upgrading the bundled binary; also watch draft PR #1618 only for clipboard streaming, not as evidence that full permission controls are coming.
